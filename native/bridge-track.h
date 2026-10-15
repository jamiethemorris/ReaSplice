#pragma once
#include <array>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <algorithm>

namespace reasplice {
constexpr int monitoringFX = 0x1000000;
struct BridgeAPI {
  void *(*master)(void *);
  void *(*projects)(int, char *, int);
  int (*count)(void *);
  int (*monitoringCount)(void *);
  bool (*config)(void *, int, const char *, char *, int);
  const void *(*guid)(void *, int);
  int (*add)(void *, const char *, bool, int);
  void (*move)(void *, int, void *, int, bool);
  bool (*remove)(void *, int);
  bool (*isOffline)(void *, int);
  bool (*isEnabled)(void *, int);
  void (*offline)(void *, int, bool);
  void (*enable)(void *, int, bool);
  void (*show)(void *, int, int);
  int (*trackCount)(void *);
  void *(*track)(void *, int);
  void (*insertTrack)(int, bool);
  void (*deleteTrack)(void *);
  bool (*trackString)(void *, const char *, char *, bool);
  double (*trackValue)(void *, const char *);
  bool (*setTrackValue)(void *, const char *, double);
  void (*adjustWindows)(bool);

};
struct BridgeResult {
  bool trackCreated = false;
  void *track = nullptr;
  bool created = false;
  bool moved = false;
  bool migrated = false;
  bool recycled = false;
  int offlined = 0;
  int index = -1;
  std::string error;
};

inline std::string fxConfig(const BridgeAPI &api, void *master, int index, const char *key) {
  char value[4096]{};
  if (!api.config(master, index, key, value, sizeof(value))) return {};
  return value;
}

inline bool isBridge(const BridgeAPI &api, void *master, int index) {
  // original_name is unaffected by user renaming; do not match display aliases.
  auto name = fxConfig(api, master, index, "original_name");
  for (auto &c : name) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return name == "vst3i: splice bridge (splice)" || name == "vst3: splice bridge (splice)" ||
      name == "aui: splice: splicebridge" || name == "au: splice: splicebridge" ||
      name == "aui: splice: splice bridge" || name == "au: splice: splice bridge";
}

inline int findBridge(const BridgeAPI &api, void *master, int index, int depth = 0) {
  if (isBridge(api, master, index)) return index;
  if (depth >= 16) return -1;
  const int count = std::atoi(fxConfig(api, master, index, "container_count").c_str());
  for (int child = 0; child < count && child < 1000; ++child) {
    auto item = fxConfig(api, master, index, ("container_item." + std::to_string(child)).c_str());
    if (item.empty()) continue;
    int found = findBridge(api, master, std::atoi(item.c_str()), depth + 1);
    if (found >= 0) return found;
  }
  return -1;
}

using FXIdentity = std::array<unsigned char, 16>;
struct BridgeState {
  void *track;
  FXIdentity identity;
  std::vector<int> path;
  bool monitoring, offline, enabled;
};

inline bool fxIdentity(const BridgeAPI &api, void *track, int index, FXIdentity &identity) {
  const void *guid = api.guid(track, index);
  if (!guid) return false;
  std::memcpy(identity.data(), guid, identity.size());
  return true;
}

// Container addresses depend on chain length. Re-resolve by GUID after a move.
inline int findIdentity(const BridgeAPI &api, void *track, int index,
                        const FXIdentity &identity, int depth = 0) {
  FXIdentity candidate{};
  if (fxIdentity(api, track, index, candidate) && candidate == identity) return index;
  if (depth >= 16) return -1;
  const int count = std::atoi(fxConfig(api, track, index, "container_count").c_str());
  for (int child = 0; child < count && child < 1000; ++child) {
    auto item = fxConfig(api, track, index, ("container_item." + std::to_string(child)).c_str());
    if (item.empty()) continue;
    int found = findIdentity(api, track, std::atoi(item.c_str()), identity, depth + 1);
    if (found >= 0) return found;
  }
  return -1;
}

inline int findIdentity(const BridgeAPI &api, void *track, const FXIdentity &identity) {
  for (int chain : {0, monitoringFX}) {
    const int count = chain ? api.monitoringCount(track) : api.count(track);
    for (int slot = 0; slot < count; ++slot) {
      int found = findIdentity(api, track, chain + slot, identity);
      if (found >= 0) return found;
    }
  }
  return -1;
}

inline bool collectBridgeStates(const BridgeAPI &api, void *track, int index,
                                bool monitoring, std::vector<int> path, std::vector<BridgeState> &states) {
  if (isBridge(api, track, index)) {
    FXIdentity identity{};
    if (!fxIdentity(api, track, index, identity)) return false;
    states.push_back({track, identity, path, monitoring, api.isOffline(track, index), api.isEnabled(track, index)});
    return true;
  }
  if (path.size() > 16) return true;
  const int count = std::atoi(fxConfig(api, track, index, "container_count").c_str());
  for (int child = 0; child < count && child < 1000; ++child) {
    auto item = fxConfig(api, track, index, ("container_item." + std::to_string(child)).c_str());
    if (item.empty()) continue;
    auto childPath = path;
    childPath.push_back(child);
    if (!collectBridgeStates(api, track, std::atoi(item.c_str()), monitoring, childPath, states)) return false;
  }
  return true;
}

// REAPER's documented container index arithmetic also addresses an empty slot,
// allowing a failed setup to put a moved child back in its original container.
inline int originalSlot(const BridgeAPI &api, const BridgeState &state) {
  const int flag = state.monitoring ? monitoringFX : 0;
  if (state.path.size() == 1) return flag + state.path[0];
  long long stride = (state.monitoring ? api.monitoringCount(state.track) : api.count(state.track)) + 1;
  long long address = state.path[0] + 1;
  int parent = flag + state.path[0];
  for (size_t depth = 1; depth < state.path.size(); ++depth) {
    address += (state.path[depth] + 1) * stride;
    if (address >= 0x1000000) return -1;
    if (depth + 1 < state.path.size()) {
      stride *= std::atoi(fxConfig(api, state.track, parent, "container_count").c_str()) + 1;
      parent = flag | 0x2000000 | static_cast<int>(address);
    }
  }
  return flag | 0x2000000 | static_cast<int>(address);
}

constexpr const char *bridgeTrackTag = "P_EXT:ReaSpliceBridge";

inline std::string trackString(const BridgeAPI &api, void *track, const char *key) {
  char value[4096]{};
  return api.trackString && api.trackString(track, key, value, false) ? value : "";
}

inline void *findBridgeTrack(const BridgeAPI &api, void *project = nullptr) {
  if (!api.trackCount || !api.track || !api.trackString) return nullptr;
  void *empty = nullptr;
  for (int i = 0; i < api.trackCount(project); ++i) {
    void *track = api.track(project, i);
    if (trackString(api, track, bridgeTrackTag) != "1") continue;
    for (int slot = 0; slot < api.count(track); ++slot)
      if (findBridge(api, track, slot) >= 0) return track;
    if (!empty) empty = track;
  }
  return empty;
}

inline BridgeResult ensureBridgeTrack(const BridgeAPI &api, bool show = false) {
  BridgeResult result;
  if (!api.master || !api.projects || !api.count || !api.monitoringCount || !api.config || !api.guid ||
      !api.add || !api.move || !api.remove || !api.isOffline || !api.isEnabled || !api.offline || !api.enable || !api.show ||
      !api.trackCount || !api.track || !api.insertTrack || !api.deleteTrack || !api.trackString || !api.trackValue || !api.setTrackValue) {
    result.error = "REAPER's track FX API is unavailable.";
    return result;
  }
  void *master = api.master(nullptr);
  if (!master) { result.error = "REAPER's master track is unavailable."; return result; }
  void *target = findBridgeTrack(api);
  std::vector<BridgeState> states;
  auto collect = [&](void *track, bool input) {
    const int count = input ? api.monitoringCount(track) : api.count(track);
    for (int slot = 0; slot < count; ++slot)
      if (!collectBridgeStates(api, track, (input ? monitoringFX : 0) + slot, input, {slot}, states)) return false;
    return true;
  };
  // Prefer the marked track; otherwise migrate this project's legacy master or
  // the global monitoring instance. An unrelated same-named track is not reused.
  if ((target && (!collect(target, false) || !collect(target, true))) ||
      !collect(master, false) || !collect(master, true)) {
    result.error = "Could not identify a Bridge FX instance."; return result;
  }
  const int selected = states.empty() ? -1 : 0;
  std::vector<void *> visited{master};
  if (target) visited.push_back(target);
  for (int projectIndex = 0; ; ++projectIndex) {
    void *project = api.projects(projectIndex, nullptr, 0);
    if (!project) break;
    for (int t = -1; t < api.trackCount(project); ++t) {
      void *track = t < 0 ? api.master(project) : api.track(project, t);
      if (!track || std::find(visited.begin(), visited.end(), track) != visited.end()) continue;
      visited.push_back(track);
      // Monitoring FX are global, so inspect them only once, above.
      if (!collect(track, false) || (t >= 0 && !collect(track, true))) {
        result.error = "Could not identify a Bridge FX instance."; return result;
      }
    }
  }
  FXIdentity identity{};
  bool identityKnown = selected >= 0;
  if (identityKnown) identity = states[selected].identity;
  void *location = selected >= 0 ? states[selected].track : nullptr;
  int index = selected < 0 ? -1 : findIdentity(api, location, identity);
  bool attemptedMove = false, changedVisibility = false;
  const double previousTCP = target ? api.trackValue(target, "B_SHOWINTCP") : 0;
  const double previousMCP = target ? api.trackValue(target, "B_SHOWINMIXER") : 0;
  auto fail = [&](const char *error) {
    result.error = error;
    bool restored = true;
    int chosen = identityKnown && target ? findIdentity(api, target, identity) : index;
    if (result.created) {
      if (chosen >= 0 && !api.remove(target, chosen)) restored = false;
    } else if (selected >= 0 && attemptedMove && chosen >= 0) {
      const auto &original = states[selected];
      const int destination = originalSlot(api, original);
      if (destination < 0) restored = false;
      else if (target != original.track || chosen != destination) {
        api.move(target, chosen, original.track, destination, true);
        if (findIdentity(api, original.track, identity) != originalSlot(api, original)) restored = false;
      }
    }
    for (bool offline : {true, false}) for (const auto &state : states) {
      if (state.offline != offline) continue;
      int fx = findIdentity(api, state.track, state.identity);
      if (fx < 0) { restored = false; continue; }
      if (api.isEnabled(state.track, fx) != state.enabled) api.enable(state.track, fx, state.enabled);
      if (api.isOffline(state.track, fx) != state.offline) api.offline(state.track, fx, state.offline);
      if (api.isOffline(state.track, fx) != state.offline || api.isEnabled(state.track, fx) != state.enabled) restored = false;
    }
    if (changedVisibility && !result.trackCreated) {
      if (!api.setTrackValue(target, "B_SHOWINTCP", previousTCP) || !api.setTrackValue(target, "B_SHOWINMIXER", previousMCP)) restored = false;
    }
    // Never delete a newly created track if rollback left an effect on it.
    if (result.trackCreated && target && !api.count(target) && !api.monitoringCount(target)) api.deleteTrack(target);
    if (api.adjustWindows) api.adjustWindows(false);
    if (!restored) result.error += " Some Bridge settings could not be restored; check the open projects' FX chains.";
    return result;
  };
  if (!target) {
    const int previousCount = api.trackCount(nullptr);
    // Index zero is always outside folders, regardless of the last track's depth.
    api.insertTrack(0, false);
    if (api.trackCount(nullptr) != previousCount + 1) return fail("Could not create the Splice Bridge track.");
    target = api.track(nullptr, 0);
    result.trackCreated = true;
    char name[] = "Splice Bridge", tag[] = "1";
    if (!target || !api.trackString(target, "P_NAME", name, true) || !api.trackString(target, bridgeTrackTag, tag, true) ||
        !api.setTrackValue(target, "B_MAINSEND", 1) || !api.setTrackValue(target, "B_SOLO_DEFEAT", 1) ||
        !api.setTrackValue(target, "D_VOL", 1) || !api.setTrackValue(target, "I_RECARM", 0) || !api.setTrackValue(target, "I_RECMON", 0))
      return fail("Could not configure the Splice Bridge track.");
  }
  // Bypass does not release Bridge's single active host. Offline every competitor
  // before moving/reloading the chosen plugin, retaining all plugin settings.
  for (size_t slot = 0; slot < states.size(); ++slot) {
    if (static_cast<int>(slot) == selected || states[slot].offline) continue;
    const auto &state = states[slot];
    int fx = findIdentity(api, state.track, state.identity);
    if (fx < 0) return fail("A Bridge FX instance changed during setup.");
    api.offline(state.track, fx, true);
    if (!api.isOffline(state.track, fx)) return fail("Could not release Bridge in another FX chain.");
    ++result.offlined;
  }
  if (selected >= 0 && !states[selected].offline) {
    api.offline(location, index, true);
    if (!api.isOffline(location, index)) return fail("Could not reset the conflicting Bridge instance.");
    result.recycled = true;
  }
  if (index < 0) {
    for (const char *name : {"VST3: Splice Bridge (Splice)", "AU: Splice: SpliceBridge", "AU: Splice: Splice Bridge"}) {
      index = api.add(target, name, false, -1);
      if (index >= 0) break;
    }
    if (index < 0) return fail("REAPER could not load Splice Bridge. Install Bridge, then rescan REAPER's plug-ins.");
    result.created = true;
    identityKnown = fxIdentity(api, target, index, identity);
    if (!identityKnown) return fail("Could not identify the Bridge FX instance.");
    location = target;
  }
  if (location != target || index >= api.count(target)) {
    attemptedMove = true;
    api.move(location, index, target, 0, true);
    index = findIdentity(api, target, identity);
    if (index != 0) return fail("Could not move Splice Bridge onto its dedicated track.");
    result.moved = true;
    result.migrated = true;
  }
  if (api.isOffline(target, index)) api.offline(target, index, false);
  if (!api.isEnabled(target, index)) api.enable(target, index, true);
  if (api.isOffline(target, index) || !api.isEnabled(target, index)) return fail("Could not activate Splice Bridge on its track.");
  changedVisibility = true;
  if (!api.setTrackValue(target, "B_SHOWINTCP", 0) || !api.setTrackValue(target, "B_SHOWINMIXER", 0))
    return fail("Could not hide the Splice Bridge track.");
  if (api.adjustWindows) api.adjustWindows(false);
  if (show) api.show(target, index, 1);
  result.index = index;
  result.track = target;
  return result;
}
} // namespace reasplice
