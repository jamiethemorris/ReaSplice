#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <cstdint>
#include <cstring>

// Public REAPER accelerator ABI. The message body is unnecessary: on macOS the
// current NSEvent and first responder are authoritative for keyboard routing.
using GetAPI = void *(*)(const char *);
using RegisterAPI = int (*)(const char *, void *);
struct AcceleratorRegistration {
  int (*translateAccel)(void *message, AcceleratorRegistration *context);
  bool isLocal;
  void *user;
};

static RegisterAPI gRegister;
static bool gLoaded, gSending;
static void *gPinned;
static NSString *gUIFile;
static uint64_t gHandled;
static void (*gConsole)(const char *);

static WKWebView *focusedDockWebView() {
  NSWindow *window = NSApp.keyWindow;
  NSResponder *responder = window.firstResponder;
  // Follow both NSView's hierarchy and the responder chain. WebKit uses an
  // internal WKContentView as first responder instead of WKWebView itself.
  for (NSUInteger depth = 0; responder && depth < 48; ++depth) {
    if ([responder isKindOfClass:[WKWebView class]]) {
      WKWebView *web = (WKWebView *)responder;
      if (web.URL.isFileURL && [[web.URL.path stringByStandardizingPath] isEqualToString:gUIFile]) return web;
      return nil;
    }
    if ([responder isKindOfClass:[NSView class]] && [(NSView *)responder superview])
      responder = [(NSView *)responder superview];
    else responder = responder.nextResponder;
  }
  return nil;
}

static int translate(void *message, AcceleratorRegistration *context) {
  WKWebView *web = focusedDockWebView();
  if (!web) return 0;
  NSEvent *event = NSApp.currentEvent;
  if (!event || (event.type != NSEventTypeKeyDown && event.type != NSEventTypeKeyUp && event.type != NSEventTypeFlagsChanged)) return 0;
  if (gSending) return 1;
  // Same routing used by ReaImGui's native Cocoa backend. Sending directly to
  // the NSWindow bypasses REAPER's shortcut table while preserving WebKit IME,
  // modifier and text handling. Return 1 so REAPER cannot also run the key.
  gSending = true;
  [web.window sendEvent:event];
  gSending = false;
  ++gHandled;
  return 1;
}

static AcceleratorRegistration gAccelerator{translate, true, nullptr};

extern "C" __attribute__((visibility("default")))
int SpliceDockKeyboard_Load(void *luaState) {
  if (gLoaded || ![NSThread isMainThread]) return 0;
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
  if (!api) return 0;
  gRegister = reinterpret_cast<RegisterAPI>(api("plugin_register"));
  gConsole = reinterpret_cast<void (*)(const char *)>(api("ShowConsoleMsg"));
  auto extState = reinterpret_cast<const char *(*)(const char *, const char *)>(api("GetExtState"));
  const char *file = extState ? extState("SpliceDock", "ui_path") : nullptr;
  if (!gRegister || !file || !file[0]) {
    if (gConsole) gConsole("Splice Dock keyboard: open Splice Dock before loading keyboard support.\n");
    return 0;
  }
  gUIFile = [[NSString stringWithUTF8String:file] stringByStandardizingPath];
  Dl_info info{};
  if (dladdr(reinterpret_cast<void *>(&SpliceDockKeyboard_Load), &info) && info.dli_fname)
    gPinned = dlopen(info.dli_fname, RTLD_NOW | RTLD_LOCAL);
  if (!gPinned) return 0;
  gLoaded = gRegister("accelerator", &gAccelerator) != 0;
  if (gConsole) gConsole(gLoaded ? "Splice Dock keyboard routing enabled.\n" : "Splice Dock keyboard routing could not register.\n");
  return 0;
}

extern "C" __attribute__((visibility("default")))
int SpliceDockKeyboard_Unload(void *luaState) {
  if (gLoaded && gRegister) gRegister("-accelerator", &gAccelerator);
  gLoaded = false;
  return 0;
}

extern "C" __attribute__((visibility("default")))
int SpliceDockKeyboard_Status(void *luaState) {
  if (gConsole) {
    NSString *message = [NSString stringWithFormat:@"Splice Dock keyboard: enabled=%d, handled=%llu, focused=%d\n", gLoaded, (unsigned long long)gHandled, focusedDockWebView() != nil];
    gConsole(message.UTF8String);
  }
  return 0;
}
