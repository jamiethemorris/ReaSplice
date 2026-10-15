#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <cstdint>
#include <cstring>
#include <cmath>
#include "host_api.h"
#include "bridge-track.h"

// Minimal ABI declarations corresponding to Cockos' public REAPER/SWELL SDK.
// Sources: https://github.com/justinfrankel/reaper-sdk/blob/main/sdk/reaper_plugin.h
// and https://github.com/justinfrankel/WDL/blob/main/WDL/swell/swell-types.h
// We import the host's functions; no private REAPER addresses or memory offsets.
using HWND = void *;
using LRESULT = intptr_t;
using WPARAM = uintptr_t;
using LPARAM = intptr_t;
using WindowProc = LRESULT (*)(HWND, unsigned, WPARAM, LPARAM);
using GetAPI = void *(*)(const char *);
using RegisterAPI = int (*)(const char *, void *);
struct ReaperPluginInfo {
  int caller_version;
  HWND hwnd_main;
  RegisterAPI Register;
  GetAPI GetFunc;
};
struct Accel { unsigned char fVirt; unsigned short key, cmd; };
struct ActionRegistration { Accel accel; const char *description; };
struct AcceleratorRegistration {
  int (*translateAccel)(void *, AcceleratorRegistration *);
  bool isLocal;
  void *user;
};
static_assert(sizeof(Accel) == 6);
constexpr int kPluginVersion = 0x20e;
constexpr unsigned WM_DESTROY = 2, WM_SIZE = 5, WM_SETFOCUS = 7;
constexpr unsigned WM_CLOSE = 0x10, WM_COMMAND = 0x111;
constexpr unsigned IDCANCEL = 2;

#ifndef SPLICE_DOCK_UI_PATH
#define SPLICE_DOCK_UI_PATH "ui/index.html"
#endif

static GetAPI gGetAPI;
static RegisterAPI gRegister;
static HWND gMainWindow, gHost;
static int gCommand;
static bool gInitialized;
static bool gSendingKey;
static void *gPinnedModule;
static ReaSpliceMessageCallback gMessageCallback;
static NSString *gAllowedFile;
static WKWebView *gWeb;
static NSEvent *gLastMouseEvent;
static id gMouseMonitor;
static NSDraggingSession *gDragSession;
static void (*Dock_UpdateDockID)(const char *, int);
static int (*DockIsChildOfDock)(HWND, bool *);
static void (*DockWindowAddEx)(HWND, const char *, const char *, bool);
static void (*DockWindowActivate)(HWND);
static void (*DockWindowRemove)(HWND);
static void (*RefreshToolbar2)(int, int);
static void (*ShowConsoleMsg)(const char *);
static const char *(*GetExtState)(const char *, const char *);
static void (*SetExtState)(const char *, const char *, const char *, bool);
static void *(*EnumProjects)(int, char *, int);
static double (*Master_GetTempo)();
static reasplice::BridgeAPI gBridgeAPI{};
static NSMutableDictionary<NSValue *, NSString *> *gProjectIDs;
static HWND (*SwellCreateDialog)(void *, const char *, HWND, WindowProc, LPARAM);
static void (*SwellDestroyWindow)(HWND);
static LRESULT (*SwellDefWindowProc)(HWND, unsigned, WPARAM, LPARAM);
static int (*SwellSetDlgItemText)(HWND, int, const char *);
static int (*InsertMedia)(const char *, int);
static void (*Undo_BeginBlock)();
static void (*MarkProjectDirty)(void *);
static void (*Undo_EndBlock)(const char *, int);
static ActionRegistration gAction{{0, 0, 0}, "ReaSplice: Toggle sample browser"};

static void closeDock();
static void showDock();
static void handleBuiltinMessage(NSDictionary *body);

static int dockIndex(HWND hwnd) {
  bool floating = false;
  return hwnd && DockIsChildOfDock ? DockIsChildOfDock(hwnd, &floating) : -1;
}

static void rememberDock(HWND hwnd) {
  const int index = dockIndex(hwnd);
  // Save before detaching the window. REAPER persists this preference for the
  // same identstr used by DockWindowAddEx, including across application restarts.
  if (index >= 0) Dock_UpdateDockID("splice_dock", index);
}

static NSString *jsonString(id value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
}

static void reportError(NSString *message) {
  NSString *line = [@"ReaSplice: " stringByAppendingFormat:@"%@\n", message];
  if (ShowConsoleMsg) ShowConsoleMsg(line.UTF8String);
  else NSLog(@"%@", line);
}

static bool allowedURL(NSURL *url) {
  return url.isFileURL && [[url.path stringByStandardizingPath] isEqualToString:gAllowedFile];
}

static NSString *projectRoot() {
  return [[gAllowedFile ?: @SPLICE_DOCK_UI_PATH stringByDeletingLastPathComponent] stringByDeletingLastPathComponent];
}

static NSDictionary *relayConfiguration() {
  NSData *data = [NSData dataWithContentsOfFile:[projectRoot() stringByAppendingPathComponent:@"build/relay-config.json"]];
  if (!data) return @{};
  id result = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [result isKindOfClass:[NSDictionary class]] ? result : @{};
}

@interface ReaSpliceControllerV10 : NSObject <WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, NSDraggingSource>
@end
static ReaSpliceControllerV10 *gController;

@implementation ReaSpliceControllerV10
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  if (!message.frameInfo.isMainFrame || !allowedURL(message.frameInfo.request.URL)) return;
  if (![message.body isKindOfClass:[NSDictionary class]]) return;
  NSDictionary *body = message.body;
  if (![body[@"id"] isKindOfClass:[NSString class]] ||
      ![body[@"type"] isKindOfClass:[NSString class]] ||
      ![body[@"payload"] isKindOfClass:[NSDictionary class]]) return;
  NSString *request = jsonString(body);
  if (!request || request.length > 1024 * 1024) return;
  if ([body[@"type"] isEqualToString:@"host.info"]) {
    NSString *result = jsonString(@{@"name": @"ReaSplice", @"version": @"0.10.0",
                                    @"docker": @(dockIndex(gHost)), @"keyboardRouting": @YES, @"projectTempo": @YES,
                                    @"tempoPreferences": @YES, @"bridgeTrack": @YES, @"bridgeSolo": @YES, @"bridgeProjectRouting": @YES, @"uiFile": gAllowedFile ?: @""});
    ReaSpliceV10_Reply([body[@"id"] UTF8String], result.UTF8String, nullptr);
  } else if ([@[@"drag", @"insert", @"launch", @"relay.config", @"project.tempo", @"tempo.preferences", @"bridge.preferences", @"bridge.ensure", @"bridge.volume", @"bridge.solo"] containsObject:body[@"type"]]) {
    handleBuiltinMessage(body);
  } else if (gMessageCallback) {
    gMessageCallback(request.UTF8String);
  } else {
    ReaSpliceV10_Reply([body[@"id"] UTF8String], nullptr, "The sample-library bridge is not loaded.");
  }
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  // Only the local application document may navigate or receive native messages.
  // Resource requests (CSS, images, audio) do not go through this policy callback.
  decisionHandler(allowedURL(action.request.URL) ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  reportError(error.localizedDescription);
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
  reportError(@"The browser process stopped. Close and reopen the ReaSplice tab to reload it.");
}
- (NSDragOperation)draggingSession:(NSDraggingSession *)session sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  return NSDragOperationCopy;
}
- (BOOL)ignoreModifierKeysForDraggingSession:(NSDraggingSession *)session { return YES; }
- (void)draggingSession:(NSDraggingSession *)session endedAtPoint:(NSPoint)point operation:(NSDragOperation)operation {
  gDragSession = nil;
  gLastMouseEvent = nil;
  NSString *script = [NSString stringWithFormat:@"window.dispatchEvent(new CustomEvent('splice:native-drag-ended',{detail:{operation:%lu}}))", (unsigned long)operation];
  [gWeb evaluateJavaScript:script completionHandler:nil];
}
@end

static NSArray<NSURL *> *validatedFiles(id files, NSString **error) {
  if (![files isKindOfClass:[NSArray class]] || [files count] == 0 || [files count] > 32) {
    *error = @"Supply between one and 32 sample files.";
    return nil;
  }
  NSSet *extensions = [NSSet setWithArray:@[@"wav", @"wave", @"aif", @"aiff", @"aifc", @"flac", @"mp3", @"ogg", @"opus", @"m4a", @"aac", @"caf", @"rx2", @"rex", @"mid", @"midi"]];
  NSMutableArray<NSURL *> *result = [NSMutableArray array];
  for (id path in files) {
    if (![path isKindOfClass:[NSString class]] || ![path isAbsolutePath] || ![extensions containsObject:[path pathExtension].lowercaseString]) {
      *error = @"Only absolute paths to supported audio or MIDI sample files are accepted.";
      return nil;
    }
    NSURL *url = [NSURL fileURLWithPath:[path stringByResolvingSymlinksInPath]];
    NSNumber *regular, *readable;
    if (![url getResourceValue:&regular forKey:NSURLIsRegularFileKey error:nil] ||
        ![url getResourceValue:&readable forKey:NSURLIsReadableKey error:nil] || !regular.boolValue || !readable.boolValue) {
      *error = @"The sample is unavailable. Download it in Splice before dragging it.";
      return nil;
    }
    [result addObject:url];
  }
  return result;
}

static bool validTempoRange(id range) {
  if (![range isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)range) == CFBooleanGetTypeID()) return false;
  double value = [range doubleValue];
  return std::isfinite(value) && value >= 1 && value <= 100;
}

static NSDictionary *tempoPreferences(NSDictionary *updates, NSString **error) {
  if (!GetExtState || !SetExtState) { *error = @"REAPER's preference storage is unavailable."; return nil; }
  NSArray *modes = @[@"none", @"exact", @"range"];
  NSString *mode = @"none";
  NSNumber *range = @10;
  const char *stored = GetExtState("ReaSplice", "tempo_preferences");
  if (stored && stored[0]) {
    NSData *data = [[NSString stringWithUTF8String:stored] dataUsingEncoding:NSUTF8StringEncoding];
    id preferences = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if ([preferences isKindOfClass:[NSDictionary class]]) {
      if ([modes containsObject:preferences[@"mode"]]) mode = preferences[@"mode"];
      if (validTempoRange(preferences[@"range"])) range = preferences[@"range"];
    }
  }
  NSDictionary *previous = @{@"mode":mode, @"range":range};
  if (updates[@"mode"]) {
    if (![updates[@"mode"] isKindOfClass:[NSString class]] || ![modes containsObject:updates[@"mode"]]) {
      *error = @"Tempo mode must be none, exact, or range.";
      return nil;
    }
    mode = updates[@"mode"];
  }
  if (updates[@"range"]) {
    if (!validTempoRange(updates[@"range"])) {
      *error = @"Tempo range must be a number from 1 to 100 BPM.";
      return nil;
    }
    range = updates[@"range"];
  }
  NSDictionary *result = @{@"mode":mode, @"range":range};
  // Validate the complete update before persisting, and never write on a read.
  if (![result isEqualToDictionary:previous])
    SetExtState("ReaSplice", "tempo_preferences", jsonString(result).UTF8String, true);
  return result;
}

static NSDictionary *bridgePreferences(NSDictionary *updates, NSString **error) {
  if (!GetExtState || !SetExtState) { *error = @"REAPER's preference storage is unavailable."; return nil; }
  NSArray *modes = @[@"disconnect", @"follow"];
  NSString *mode = @"disconnect";
  const char *stored = GetExtState("ReaSplice", "bridge_preferences");
  if (stored && stored[0]) {
    NSData *data = [[NSString stringWithUTF8String:stored] dataUsingEncoding:NSUTF8StringEncoding];
    id preferences = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if ([preferences isKindOfClass:[NSDictionary class]] && [modes containsObject:preferences[@"switchMode"]])
      mode = preferences[@"switchMode"];
  }
  NSString *previous = mode;
  if (updates[@"switchMode"]) {
    if (![updates[@"switchMode"] isKindOfClass:[NSString class]] || ![modes containsObject:updates[@"switchMode"]]) {
      *error = @"Bridge switch mode must be disconnect or follow.";
      return nil;
    }
    mode = updates[@"switchMode"];
  }
  NSDictionary *result = @{@"switchMode":mode};
  if (![mode isEqualToString:previous])
    SetExtState("ReaSplice", "bridge_preferences", jsonString(result).UTF8String, true);
  return result;
}

static NSString *activeProjectID(NSString **error) {
  if (!EnumProjects) { *error = @"REAPER's project API is unavailable."; return nil; }
  void *project = EnumProjects(-1, nullptr, 0);
  if (!project) { *error = @"No active project is available."; return nil; }
  if (!gProjectIDs) gProjectIDs = [NSMutableDictionary dictionary];
  NSMutableSet<NSValue *> *openProjects = [NSMutableSet set];
  for (int index = 0; ; ++index) {
    void *open = EnumProjects(index, nullptr, 0);
    if (!open) break;
    [openProjects addObject:[NSValue valueWithPointer:open]];
  }
  for (NSValue *key in gProjectIDs.allKeys)
    if (![openProjects containsObject:key]) [gProjectIDs removeObjectForKey:key];
  NSValue *key = [NSValue valueWithPointer:project];
  if (!gProjectIDs[key]) gProjectIDs[key] = NSUUID.UUID.UUIDString;
  return gProjectIDs[key];
}

static NSDictionary *projectTempo(NSString **error) {
  if (!Master_GetTempo) { *error = @"REAPER's project tempo API is unavailable."; return nil; }
  // Both reads happen on the main thread, so a request refers to one project.
  NSString *projectID = activeProjectID(error);
  if (!projectID) return nil;
  double bpm = Master_GetTempo();
  if (!std::isfinite(bpm) || bpm <= 0) { *error = @"No valid active project tempo is available."; return nil; }
  return @{@"bpm":@(bpm), @"projectId":projectID};
}

static void handleBuiltinMessage(NSDictionary *body) {
  NSString *identifier = body[@"id"], *type = body[@"type"];
  NSDictionary *payload = body[@"payload"];
  if ([type isEqualToString:@"bridge.volume"] || [type isEqualToString:@"bridge.solo"]) {
    NSString *error = nil;
    NSString *projectID = activeProjectID(&error);
    void *track = reasplice::findBridgeTrack(gBridgeAPI);
    NSString *trackID = track ? @(reasplice::trackString(gBridgeAPI, track, "GUID").c_str()) : @"";
    id volume = payload[@"volume"];
    id solo = payload[@"solo"];
    if (!gBridgeAPI.trackValue) error = @"REAPER's track controls are unavailable.";
    if (volume || solo) {
      if (![payload[@"projectId"] isKindOfClass:[NSString class]] || ![payload[@"projectId"] isEqualToString:projectID] ||
          !track || ![payload[@"trackId"] isKindOfClass:[NSString class]] || !trackID.length || ![payload[@"trackId"] isEqualToString:trackID])
        error = @"The preview track or active project changed. Try the control again.";
      else if (solo && (volume || ![type isEqualToString:@"bridge.solo"] || ![solo isKindOfClass:[NSNumber class]] ||
          CFGetTypeID((__bridge CFTypeRef)solo) != CFBooleanGetTypeID()))
        error = @"Preview solo must be a boolean.";
      else if (volume && (![type isEqualToString:@"bridge.volume"] || ![volume isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)volume) == CFBooleanGetTypeID() ||
          !std::isfinite([volume doubleValue]) || [volume doubleValue] < 0 || [volume doubleValue] > 4)
        )
        error = @"Invalid preview volume.";
      if (!error) {
        // Solo in place respects the preview track's normal routing. Change
        // this track only; preserve every other track's existing solo state.
        if (solo && Undo_BeginBlock && Undo_EndBlock) Undo_BeginBlock();
        if (!gBridgeAPI.setTrackValue || !gBridgeAPI.setTrackValue(track,
            solo ? "I_SOLO" : "D_VOL", solo ? ([solo boolValue] ? 2 : 0) : [volume doubleValue]))
          error = @"Could not change the preview track control.";
        else if (MarkProjectDirty) MarkProjectDirty(nullptr);
        if (solo && Undo_BeginBlock && Undo_EndBlock) Undo_EndBlock([solo boolValue] ? "Solo Splice Bridge track" : "Unsolo Splice Bridge track", 1);
      }
    }
    if (error) { ReaSpliceV10_Reply(identifier.UTF8String, nullptr, error.UTF8String); return; }
    NSDictionary *result = track ? @{@"projectId":projectID, @"trackId":trackID,
        @"trackName":@(reasplice::trackString(gBridgeAPI, track, "P_NAME").c_str()),
        @"volume":@(gBridgeAPI.trackValue(track, "D_VOL")),
        @"solo":@(gBridgeAPI.trackValue(track, "I_SOLO") != 0)} : @{@"projectId":projectID};
    ReaSpliceV10_Reply(identifier.UTF8String, jsonString(result).UTF8String, nullptr);
    return;
  }
  if ([type isEqualToString:@"bridge.ensure"]) {
    NSString *error = nil;
    NSString *projectID = activeProjectID(&error);
    if (payload[@"projectId"] && (![payload[@"projectId"] isKindOfClass:[NSString class]] ||
        ![payload[@"projectId"] isEqualToString:projectID]))
      error = @"The active REAPER project changed before Bridge setup. Try again in the current project.";
    id show = payload[@"show"];
    if (show && (![show isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)show) != CFBooleanGetTypeID()))
      error = @"Bridge show must be a boolean.";
    if (error) { ReaSpliceV10_Reply(identifier.UTF8String, nullptr, error.UTF8String); return; }
    if (Undo_BeginBlock && Undo_EndBlock) Undo_BeginBlock();
    auto result = reasplice::ensureBridgeTrack(gBridgeAPI, show && [show boolValue]);
    if (Undo_BeginBlock && Undo_EndBlock) Undo_EndBlock("Set up Splice Bridge track", -1);
    NSString *json = jsonString(@{@"trackCreated":@(result.trackCreated), @"created":@(result.created), @"moved":@(result.moved), @"migrated":@(result.migrated),
        @"recycled":@(result.recycled), @"offlined":@(result.offlined), @"index":@(result.index), @"projectId":projectID});
    ReaSpliceV10_Reply(identifier.UTF8String, result.error.empty() ? json.UTF8String : nullptr,
        result.error.empty() ? nullptr : result.error.c_str());
    return;
  }
  if ([type isEqualToString:@"project.tempo"] || [type isEqualToString:@"tempo.preferences"] || [type isEqualToString:@"bridge.preferences"]) {
    NSString *error = nil;
    NSDictionary *result;
    if ([type isEqualToString:@"project.tempo"]) result = projectTempo(&error);
    else if ([type isEqualToString:@"bridge.preferences"]) result = bridgePreferences(payload, &error);
    else result = tempoPreferences(payload, &error);
    ReaSpliceV10_Reply(identifier.UTF8String, result ? jsonString(result).UTF8String : nullptr, error ? error.UTF8String : nullptr);
    return;
  }
  if ([type isEqualToString:@"relay.config"]) {
    ReaSpliceV10_Reply(identifier.UTF8String, jsonString(relayConfiguration()).UTF8String, nullptr);
    return;
  }
  if ([type isEqualToString:@"launch"]) {
    NSString *appPath = [[projectRoot() stringByAppendingPathComponent:@"build/ReaSplice.app"] stringByResolvingSymlinksInPath];
    if (![[NSFileManager defaultManager] fileExistsAtPath:appPath]) {
      ReaSpliceV10_Reply(identifier.UTF8String, nullptr, "The private ReaSplice app has not been built yet.");
      return;
    }
    NSBundle *bundle = [NSBundle bundleWithPath:appPath];
    NSString *bundleIdentifier = bundle.bundleIdentifier;
    if (!bundleIdentifier.length) {
      ReaSpliceV10_Reply(identifier.UTF8String, nullptr, "The private ReaSplice app is incomplete. Rebuild it before launching.");
      return;
    }
    bool privateCopyRunning = false;
    for (NSRunningApplication *running in [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleIdentifier]) {
      if (running.terminated) continue;
      NSString *runningPath = [running.bundleURL.path stringByResolvingSymlinksInPath];
      if (![runningPath isEqualToString:appPath]) {
        ReaSpliceV10_Reply(identifier.UTF8String, nullptr,
          "Quit the regular Splice app and click Launch Splice again so the dock can start its private copy.");
        return;
      }
      privateCopyRunning = true;
    }
    if (privateCopyRunning) {
      ReaSpliceV10_Reply(identifier.UTF8String, "{\"launched\":true,\"alreadyRunning\":true}", nullptr);
      return;
    }
    NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
    configuration.activates = NO;
    configuration.createsNewApplicationInstance = YES;
    [[NSWorkspace sharedWorkspace] openApplicationAtURL:[NSURL fileURLWithPath:appPath]
      configuration:configuration completionHandler:^(NSRunningApplication *app, NSError *error) {
        ReaSpliceV10_Reply(identifier.UTF8String, "{\"launched\":true}", error ? error.localizedDescription.UTF8String : nullptr);
      }];
    return;
  }
  NSString *error;
  NSArray<NSURL *> *files = validatedFiles(payload[@"files"], &error);
  if (!files) { ReaSpliceV10_Reply(identifier.UTF8String, nullptr, error.UTF8String); return; }
  if ([type isEqualToString:@"insert"]) {
    if (!InsertMedia) { ReaSpliceV10_Reply(identifier.UTF8String, nullptr, "REAPER's insert API is unavailable."); return; }
    if (Undo_BeginBlock) Undo_BeginBlock();
    NSMutableArray *results = [NSMutableArray array];
    int mode = [payload[@"newTrack"] boolValue] ? 1 : 0;
    for (NSURL *file in files) [results addObject:@(InsertMedia(file.path.UTF8String, mode))];
    if (Undo_EndBlock) Undo_EndBlock("Insert Splice sample", -1);
    ReaSpliceV10_Reply(identifier.UTF8String, jsonString(@{@"results":results}).UTF8String, nullptr);
    return;
  }
  if (gDragSession) { ReaSpliceV10_Reply(identifier.UTF8String, nullptr, "A sample drag is already in progress."); return; }
  NSEvent *event = gLastMouseEvent;
  if (!gWeb || !event || event.window != gWeb.window || !([NSEvent pressedMouseButtons] & 1)) {
    ReaSpliceV10_Reply(identifier.UTF8String, nullptr, "Keep the mouse button held while dragging a downloaded sample into REAPER.");
    return;
  }
  NSPoint point = [gWeb convertPoint:event.locationInWindow fromView:nil];
  NSMutableArray<NSDraggingItem *> *items = [NSMutableArray array];
  for (NSURL *file in files) {
    NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:file];
    NSImage *icon = [[NSWorkspace sharedWorkspace] iconForFile:file.path];
    [item setDraggingFrame:NSMakeRect(point.x - 22, point.y - 22, 44, 44) contents:icon];
    [items addObject:item];
    point.x += 6; point.y += 6;
  }
  gDragSession = [gWeb beginDraggingSessionWithItems:items event:event source:gController];
  gDragSession.animatesToStartingPositionsOnCancelOrFail = YES;
  ReaSpliceV10_Reply(identifier.UTF8String, "{\"started\":true}", nullptr);
}

static NSString *bridgeScript() {
  return @R"JS((() => {
    const pending = new Map();
    const session = Math.random().toString(36).slice(2);
    let nextID = 0;
    const bridge = {
      request(type, payload = {}) {
        const id = `${session}:${++nextID}`;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('Native request timed out.'));
          }, 60000);
          pending.set(id, {resolve, reject, timer});
          window.webkit.messageHandlers.splice.postMessage({id, type, payload});
        });
      },
      _receive(reply) {
        const item = pending.get(reply.id);
        if (!item) return;
        pending.delete(reply.id);
        clearTimeout(item.timer);
        if (reply.ok) item.resolve(reply.result);
        else item.reject(new Error(reply.error || 'Native request failed.'));
      }
    };
    Object.defineProperty(window, 'spliceNative', {value: Object.freeze(bridge), writable: false});
  })();)JS";
}

extern "C" __attribute__((visibility("default")))
void ReaSpliceV10_SetMessageCallback(ReaSpliceMessageCallback callback) { gMessageCallback = callback; }

extern "C" __attribute__((visibility("default")))
void *ReaSpliceV10_GetReaperAPI(const char *name) { return gGetAPI ? gGetAPI(name) : nullptr; }

extern "C" __attribute__((visibility("default")))
void ReaSpliceV10_Reply(const char *requestID, const char *resultJSON, const char *error) {
  NSString *identifier = requestID ? [NSString stringWithUTF8String:requestID] : nil;
  if (!identifier) return;
  NSString *errorText = error ? [NSString stringWithUTF8String:error] : nil;
  id result = [NSNull null];
  if (resultJSON && !errorText) {
    NSData *data = [[NSString stringWithUTF8String:resultJSON] dataUsingEncoding:NSUTF8StringEncoding];
    NSError *parseError;
    result = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:&parseError];
    if (!result) errorText = @"The native bridge returned invalid JSON.";
  }
  NSString *reply = jsonString(@{@"id": identifier, @"ok": @(!errorText),
                                @"result": result ?: [NSNull null], @"error": errorText ?: @""});
  dispatch_async(dispatch_get_main_queue(), ^{
    if (gWeb && reply) {
      [gWeb evaluateJavaScript:[@"window.spliceNative._receive(" stringByAppendingFormat:@"%@)", reply]
            completionHandler:nil];
    }
  });
}

static LRESULT windowProc(HWND hwnd, unsigned message, WPARAM wp, LPARAM lp) {
  if (message == WM_CLOSE || (message == WM_COMMAND && (wp & 0xffff) == IDCANCEL)) {
    closeDock();
    return 0;
  }
  if (message == WM_SIZE && gWeb) {
    gWeb.frame = [(__bridge NSView *)hwnd bounds];
    return 0;
  }
  if (message == WM_SETFOCUS && gWeb) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (gHost == hwnd && gWeb) [[gWeb window] makeFirstResponder:gWeb];
    });
    return 0;
  }
  if (message == WM_DESTROY && hwnd == gHost) {
    rememberDock(hwnd);
    gHost = nullptr;
    if (gMouseMonitor) [NSEvent removeMonitor:gMouseMonitor];
    gMouseMonitor = nil;
    gLastMouseEvent = nil;
    [gWeb.configuration.userContentController removeScriptMessageHandlerForName:@"splice"];
    gWeb = nil;
    gController = nil;
    DockWindowRemove(hwnd);
    return 0;
  }
  return SwellDefWindowProc ? SwellDefWindowProc(hwnd, message, wp, lp) : 0;
}

static void closeDock() {
  if (!gHost) return;
  HWND host = gHost;
  rememberDock(host);
  gHost = nullptr;
  if (gMouseMonitor) [NSEvent removeMonitor:gMouseMonitor];
  gMouseMonitor = nil;
  gLastMouseEvent = nil;
  [gWeb stopLoading];
  [gWeb.configuration.userContentController removeScriptMessageHandlerForName:@"splice"];
  [gWeb removeFromSuperview];
  gWeb = nil;
  gController = nil;
  DockWindowRemove(host);
  SwellDestroyWindow(host);
  if (RefreshToolbar2) RefreshToolbar2(0, gCommand);
}

static void showDock() {
  if (gHost) { DockWindowActivate(gHost); return; }
  const char *configured = GetExtState ? GetExtState("ReaSplice", "ui_path") : nullptr;
  NSString *path = [NSString stringWithUTF8String:configured && configured[0] ? configured : SPLICE_DOCK_UI_PATH];
  gAllowedFile = [path stringByStandardizingPath];
  if (![[NSFileManager defaultManager] fileExistsAtPath:gAllowedFile]) {
    reportError([@"Cannot find the interface: " stringByAppendingString:gAllowedFile]);
    return;
  }
  // 0x400008 creates a top-level SWELL dialog without a resource; bit 1 makes it resizable.
  gHost = SwellCreateDialog(nullptr, reinterpret_cast<const char *>(0x400009), gMainWindow, windowProc, 0);
  if (!gHost) { reportError(@"REAPER could not create the dock container."); return; }
  NSView *container = (__bridge NSView *)gHost;
  [container setFrameSize:NSMakeSize(340, 800)];
  SwellSetDlgItemText(gHost, 0, "ReaSplice");
  WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
  configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
  configuration.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
  gController = [ReaSpliceControllerV10 new];
  [configuration.userContentController addScriptMessageHandler:gController name:@"splice"];
  NSString *configScript = [@"Object.defineProperty(window,'spliceRelay',{value:" stringByAppendingFormat:@"%@,writable:false});", jsonString(relayConfiguration())];
  [configuration.userContentController addUserScript:[[WKUserScript alloc]
      initWithSource:configScript injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
  [configuration.userContentController addUserScript:[[WKUserScript alloc]
      initWithSource:bridgeScript() injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
  gWeb = [[WKWebView alloc] initWithFrame:container.bounds configuration:configuration];
  gWeb.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  gWeb.navigationDelegate = gController;
  gWeb.UIDelegate = gController;
  [container addSubview:gWeb];
  gMouseMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:(NSEventMaskLeftMouseDown | NSEventMaskLeftMouseDragged)
    handler:^NSEvent *(NSEvent *event) {
      if (gWeb && event.window == gWeb.window) {
        NSPoint point = [gWeb convertPoint:event.locationInWindow fromView:nil];
        if (NSPointInRect(point, gWeb.bounds)) gLastMouseEvent = event;
      }
      return event;
    }];
  NSURL *fileURL = [NSURL fileURLWithPath:gAllowedFile];
  [gWeb loadFileURL:fileURL allowingReadAccessToURL:[fileURL URLByDeletingLastPathComponent]];
  // Let REAPER restore this tab's saved docker instead of forcing a new split.
  DockWindowAddEx(gHost, "ReaSplice", "splice_dock", true);
  DockWindowActivate(gHost);
  if (RefreshToolbar2) RefreshToolbar2(0, gCommand);
}

static bool onCommand(int command, int flag) {
  if (command != gCommand) return false;
  if (gHost) closeDock(); else showDock();
  return true;
}

static int toggleState(int command) { return command == gCommand ? (gHost ? 1 : 0) : -1; }

static int hwndInfo(HWND hwnd, intptr_t type) {
  if (!gWeb || !hwnd || (type != 0 && type != 1)) return 0;
  id view = (__bridge id)hwnd;
  if ([view isKindOfClass:[NSView class]] && [view isDescendantOf:gWeb]) return 1;
  return 0;
}

static int translateAccelerator(void *message, AcceleratorRegistration *context) {
  if (!gWeb) return 0;
  NSResponder *responder = NSApp.keyWindow.firstResponder;
  bool ours = false;
  for (NSUInteger depth = 0; responder && depth < 48; ++depth) {
    if (responder == gWeb) { ours = true; break; }
    if ([responder isKindOfClass:[NSView class]] && [(NSView *)responder superview])
      responder = [(NSView *)responder superview];
    else responder = responder.nextResponder;
  }
  if (!ours) return 0;
  NSEvent *event = NSApp.currentEvent;
  if (!event || (event.type != NSEventTypeKeyDown && event.type != NSEventTypeKeyUp && event.type != NSEventTypeFlagsChanged)) return 0;
  if (gSendingKey) return 1;
  // Deliver straight to Cocoa and eat REAPER's shortcut processing, as in
  // ReaImGui's Cocoa backend. hwnd_info alone does not protect every key.
  gSendingKey = true;
  [gWeb.window sendEvent:event];
  gSendingKey = false;
  return 1;
}

static AcceleratorRegistration gAccelerator{translateAccelerator, true, nullptr};

template<typename T> static bool import(T &destination, GetAPI api, const char *name) {
  destination = reinterpret_cast<T>(api(name));
  return destination != nullptr;
}

static bool initialize(GetAPI api, RegisterAPI registration, HWND mainWindow) {
  if (gInitialized) return true;
  if (!api || !registration || !mainWindow) return false;
  gGetAPI = api; gRegister = registration; gMainWindow = mainWindow;
  import(ShowConsoleMsg, api, "ShowConsoleMsg");
  bool valid = import(Dock_UpdateDockID, api, "Dock_UpdateDockID") &&
      import(DockIsChildOfDock, api, "DockIsChildOfDock") &&
      import(DockWindowAddEx, api, "DockWindowAddEx") &&
      import(DockWindowActivate, api, "DockWindowActivate") &&
      import(DockWindowRemove, api, "DockWindowRemove");
  import(RefreshToolbar2, api, "RefreshToolbar2");
  import(GetExtState, api, "GetExtState");
  import(SetExtState, api, "SetExtState");
  import(EnumProjects, api, "EnumProjects");
  import(Master_GetTempo, api, "Master_GetTempo");
  import(gBridgeAPI.master, api, "GetMasterTrack");
  import(gBridgeAPI.projects, api, "EnumProjects");
  import(gBridgeAPI.count, api, "TrackFX_GetCount");
  import(gBridgeAPI.monitoringCount, api, "TrackFX_GetRecCount");
  import(gBridgeAPI.config, api, "TrackFX_GetNamedConfigParm");
  import(gBridgeAPI.guid, api, "TrackFX_GetFXGUID");
  import(gBridgeAPI.add, api, "TrackFX_AddByName");
  import(gBridgeAPI.move, api, "TrackFX_CopyToTrack");
  import(gBridgeAPI.remove, api, "TrackFX_Delete");
  import(gBridgeAPI.isOffline, api, "TrackFX_GetOffline");
  import(gBridgeAPI.isEnabled, api, "TrackFX_GetEnabled");
  import(gBridgeAPI.offline, api, "TrackFX_SetOffline");
  import(gBridgeAPI.enable, api, "TrackFX_SetEnabled");
  import(gBridgeAPI.show, api, "TrackFX_Show");
  import(gBridgeAPI.trackCount, api, "CountTracks");
  import(gBridgeAPI.track, api, "GetTrack");
  import(gBridgeAPI.insertTrack, api, "InsertTrackAtIndex");
  import(gBridgeAPI.deleteTrack, api, "DeleteTrack");
  import(gBridgeAPI.trackString, api, "GetSetMediaTrackInfo_String");
  import(gBridgeAPI.trackValue, api, "GetMediaTrackInfo_Value");
  import(gBridgeAPI.setTrackValue, api, "SetMediaTrackInfo_Value");
  import(gBridgeAPI.adjustWindows, api, "TrackList_AdjustWindows");
  import(MarkProjectDirty, api, "MarkProjectDirty");
  import(InsertMedia, api, "InsertMedia");
  import(Undo_BeginBlock, api, "Undo_BeginBlock");
  import(Undo_EndBlock, api, "Undo_EndBlock");
  id delegate = NSApp.delegate;
  SEL selector = sel_registerName("swellGetAPPAPIFunc");
  GetAPI swellAPI = nullptr;
  if ([delegate respondsToSelector:selector]) {
    swellAPI = reinterpret_cast<GetAPI>(reinterpret_cast<void *(*)(id, SEL)>(objc_msgSend)(delegate, selector));
  }
  if (!swellAPI || swellAPI(nullptr) != reinterpret_cast<void *>(0x100)) valid = false;
  if (valid) {
    valid = import(SwellCreateDialog, swellAPI, "SWELL_CreateDialog") &&
        import(SwellDestroyWindow, swellAPI, "DestroyWindow") &&
        import(SwellDefWindowProc, swellAPI, "DefWindowProc") &&
        import(SwellSetDlgItemText, swellAPI, "SetDlgItemText");
  }
  if (!valid) { reportError(@"Required REAPER or SWELL APIs are unavailable."); return false; }
  gCommand = registration("command_id", const_cast<char *>("REASPLICETOGGLE"));
  if (!gCommand) return false;
  gAction.accel.cmd = static_cast<unsigned short>(gCommand);
  registration("gaccel", &gAction);
  registration("hookcommand", reinterpret_cast<void *>(onCommand));
  registration("toggleaction", reinterpret_cast<void *>(toggleState));
  registration("hwnd_info", reinterpret_cast<void *>(hwndInfo));
  registration("accelerator", &gAccelerator);
  gInitialized = true;
  if (SetExtState) {
    SetExtState("ReaSplice", "native_version", "0.10.0", false);
    SetExtState("ReaSplice", "native_capabilities", "project.tempo,tempo.preferences,bridge.ensure,bridge.preferences,bridge.volume,bridge.solo", false);
  }
  return true;
}

static void shutdown() {
  closeDock();
  if (!gInitialized) return;
  gRegister("-accelerator", &gAccelerator);
  gRegister("-hwnd_info", reinterpret_cast<void *>(hwndInfo));
  gRegister("-toggleaction", reinterpret_cast<void *>(toggleState));
  gRegister("-hookcommand", reinterpret_cast<void *>(onCommand));
  gRegister("-gaccel", &gAction);
  gMessageCallback = nullptr;
  gProjectIDs = nil;
  gInitialized = false;
  if (SetExtState && GetExtState && !std::strcmp(GetExtState("ReaSplice", "native_version"), "0.10.0")) {
    SetExtState("ReaSplice", "native_version", "", false);
    SetExtState("ReaSplice", "native_capabilities", "", false);
  }
}

extern "C" __attribute__((visibility("default")))
int ReaperPluginEntry(void *instance, ReaperPluginInfo *info) {
  if (!info) { shutdown(); return 0; }
  if (info->caller_version != kPluginVersion) return 0;
  return initialize(info->GetFunc, info->Register, info->hwnd_main) ? 1 : 0;
}

// Lua calls a C function with lua_State* and expects the number of return values.
// This entry does not touch Lua state, so it requires no Lua headers or symbols.
// It uses the API pointer exported by the already-loaded js_ReaScriptAPI plugin.
extern "C" __attribute__((visibility("default")))
int ReaSpliceV10_Load(void *luaState) {
  if (gInitialized) return 0;
  if (![NSThread isMainThread]) { reportError(@"Load the extension on REAPER's main thread."); return 0; }
  GetAPI api = nullptr;
  for (uint32_t index = 0; index < _dyld_image_count() && !api; ++index) {
    const char *path = _dyld_get_image_name(index);
    if (!path || !std::strstr(path, "reaper_js_ReaScriptAPI")) continue;
    void *handle = dlopen(path, RTLD_LAZY | RTLD_NOLOAD);
    if (!handle) continue;
    auto symbol = reinterpret_cast<GetAPI *>(dlsym(handle, "plugin_getapi"));
    if (symbol) api = *symbol;
    dlclose(handle);
  }
  if (!api) {
    reportError(@"Live loading requires the installed js_ReaScriptAPI extension. Alternatively install the dylib in UserPlugins and restart REAPER.");
    return 0;
  }
  auto registration = reinterpret_cast<RegisterAPI>(api("plugin_register"));
  auto mainWindow = reinterpret_cast<HWND (*)()>(api("GetMainHwnd"));
  if (initialize(api, registration, mainWindow ? mainWindow() : nullptr)) {
    // Lua may release its dlopen reference when the script ends. Keep callbacks
    // and Objective-C classes resident for the remaining REAPER process lifetime.
    Dl_info moduleInfo{};
    if (dladdr(reinterpret_cast<void *>(&ReaSpliceV10_Load), &moduleInfo) && moduleInfo.dli_fname)
      gPinnedModule = dlopen(moduleInfo.dli_fname, RTLD_NOW | RTLD_LOCAL);
    if (!gPinnedModule) { shutdown(); reportError(@"Could not keep the extension loaded safely."); }
  }
  return 0;
}

extern "C" __attribute__((visibility("default")))
int ReaSpliceV10_Unload(void *luaState) {
  shutdown();
  // Deliberately retain the module: Objective-C runtime classes cannot be unloaded.
  return 0;
}

extern "C" __attribute__((visibility("default")))
int ReaSpliceV10_Reload(void *luaState) {
  if (gInitialized && [NSThread isMainThread]) {
    closeDock();
    showDock();
  }
  return 0;
}
