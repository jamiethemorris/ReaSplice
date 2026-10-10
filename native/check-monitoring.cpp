// Offline checks; never load a plugin or touch a running REAPER instance.
#include "monitoring-bridge.h"
#include <algorithm>
#include <cassert>
#include <iostream>
#include <vector>

struct FX { std::string name; std::array<unsigned char,16> guid; bool enabled = true, offline = false; };
static std::vector<FX> chain;
static bool installed = true, moveWorks = true;
static int added, shown;
static FX bridge{{"VST3i: Splice Bridge (Splice)"}, {9}};
static FX &at(int index) {
  assert(index & reasplice::monitoringFX);
  return chain.at(index & ~reasplice::monitoringFX);
}
int main() {
  reasplice::MonitoringAPI api{
    [](void *) -> void * { return &chain; },
    [](void *track) { assert(track == &chain); return (int)chain.size(); },
    [](void *, int index, const char *key, char *out, int size) {
      if (std::strcmp(key, "original_name")) return false;
      std::snprintf(out, size, "%s", at(index).name.c_str()); return true;
    },
    [](void *, int index) -> const void * { return at(index).guid.data(); },
    [](void *track, const char *, bool rec, int mode) {
      assert(track == &chain && rec && mode == -1);
      if (!installed) return -1;
      ++added; chain.push_back(bridge); return (int)chain.size()-1;
    },
    [](void *src, int index, void *dest, int slot, bool move) {
      assert(src == &chain && dest == &chain && move);
      assert(slot == reasplice::monitoringFX + (int)chain.size());
      if (!moveWorks) return;
      FX item = at(index); chain.erase(chain.begin() + (index & ~reasplice::monitoringFX)); chain.push_back(item);
    },
    [](void *, int index, bool offline) { at(index).offline = offline; },
    [](void *, int index, bool enabled) { at(index).enabled = enabled; },
    [](void *, int index, int mode) { assert(mode == 1); shown = index; }
  };
  chain = {{"EQ", {1}}, {"Meter", {2}, false}};
  auto result = reasplice::ensureMonitoringBridge(api);
  assert(result.error.empty() && result.created && !result.moved && added == 1);
  assert(chain.size() == 3 && chain[0].guid[0] == 1 && chain[1].guid[0] == 2 && !chain[1].enabled);
  assert(shown == reasplice::monitoringFX + 2);
  result = reasplice::ensureMonitoringBridge(api);
  assert(result.error.empty() && !result.created && !result.moved && added == 1 && chain.size() == 3);
  std::rotate(chain.begin(), chain.end()-1, chain.end());
  chain[0].offline = true; chain[0].enabled = false;
  result = reasplice::ensureMonitoringBridge(api);
  assert(result.error.empty() && result.moved && !result.created && added == 1);
  assert(chain[0].guid[0] == 1 && chain[1].guid[0] == 2 && chain.back().guid[0] == 9);
  assert(chain.back().enabled && !chain.back().offline && !chain[1].enabled);
  chain = {{"EQ", {1}}}; installed = false;
  result = reasplice::ensureMonitoringBridge(api);
  assert(!result.error.empty() && chain.size() == 1 && added == 1);
  chain = {bridge, {"Meter", {2}}}; moveWorks = false;
  result = reasplice::ensureMonitoringBridge(api);
  assert(!result.error.empty() && chain.size() == 2);
  std::cout << "Monitoring Bridge checks passed: append, reuse, order/state preservation, enable, missing plugin, failed move.\n";
}
