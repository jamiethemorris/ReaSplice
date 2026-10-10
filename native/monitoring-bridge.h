#pragma once
#include <array>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <string>

namespace reasplice {
constexpr int monitoringFX = 0x1000000;
struct MonitoringAPI {
  void *(*master)(void *);
  int (*count)(void *);
  bool (*config)(void *, int, const char *, char *, int);
  const void *(*guid)(void *, int);
  int (*add)(void *, const char *, bool, int);
  void (*move)(void *, int, void *, int, bool);
  void (*offline)(void *, int, bool);
  void (*enable)(void *, int, bool);
  void (*show)(void *, int, int);
};
struct BridgeResult {
  bool created = false;
  bool moved = false;
  int index = -1;
  std::string error;
};

inline std::string fxConfig(const MonitoringAPI &api, void *master, int index, const char *key) {
  char value[4096]{};
  if (!api.config(master, index, key, value, sizeof(value))) return {};
  return value;
}

inline bool isBridge(const MonitoringAPI &api, void *master, int index) {
  // original_name is unaffected by user renaming; do not match display aliases.
  auto name = fxConfig(api, master, index, "original_name");
  for (auto &c : name) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return name == "vst3i: splice bridge (splice)" || name == "vst3: splice bridge (splice)" ||
      name == "aui: splice: splicebridge" || name == "au: splice: splicebridge" ||
      name == "aui: splice: splice bridge" || name == "au: splice: splice bridge";
}

inline int findBridge(const MonitoringAPI &api, void *master, int index, int depth = 0) {
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

inline BridgeResult ensureMonitoringBridge(const MonitoringAPI &api) {
  BridgeResult result;
  if (!api.master || !api.count || !api.config || !api.guid || !api.add || !api.move ||
      !api.offline || !api.enable || !api.show) {
    result.error = "REAPER's monitoring FX API is unavailable.";
    return result;
  }
  void *master = api.master(nullptr);
  if (!master) { result.error = "REAPER's master track is unavailable."; return result; }
  int count = api.count(master);
  int index = -1;
  for (int slot = 0; slot < count && index < 0; ++slot)
    index = findBridge(api, master, monitoringFX + slot);
  if (index < 0) {
    // recFX=true on the master is the monitoring chain. -1 appends a new FX.
    for (const char *name : {"VST3: Splice Bridge (Splice)", "AU: Splice: SpliceBridge", "AU: Splice: Splice Bridge"}) {
      index = api.add(master, name, true, -1);
      if (index >= 0) { index |= monitoringFX; break; }
    }
    if (index < 0) {
      result.error = "REAPER could not load Splice Bridge. Install Bridge, then rescan REAPER's plug-ins.";
      return result;
    }
    result.created = true;
  }
  const void *guid = api.guid(master, index);
  if (!guid) { result.error = "Could not identify the Bridge FX instance."; return result; }
  std::array<unsigned char, 16> identity{};
  std::memcpy(identity.data(), guid, identity.size());
  count = api.count(master);
  if (index != monitoringFX + count - 1) {
    // Move only Bridge; preserve every other effect's relative order and state.
    api.move(master, index, master, monitoringFX + count, true);
    result.moved = true;
  }
  index = monitoringFX + api.count(master) - 1;
  guid = api.guid(master, index);
  if (!guid || std::memcmp(identity.data(), guid, identity.size())) {
    result.error = "Could not place Splice Bridge at the end of monitoring FX.";
    return result;
  }
  api.offline(master, index, false);
  api.enable(master, index, true);
  api.show(master, index, 1);
  result.index = index;
  return result;
}
} // namespace reasplice
