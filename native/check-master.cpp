// Offline checks; never load a plugin or touch a running REAPER instance.
#include "master-bridge.h"
#include <algorithm>
#include <cassert>
#include <iostream>
#include <vector>

struct FX {
  std::string name;
  std::array<unsigned char,16> guid;
  bool enabled = true, offline = false;
  std::vector<FX> children{};
};
struct Project { std::vector<FX> chain; };
static Project first, second;
static Project *active = &first;
static std::vector<FX> monitoring;
static bool installed = true, moveWorks = true;
static int added, shown;
static FX bridge{"VST3i: Splice Bridge (Splice)", {9}};
struct Location { std::vector<FX> *chain; int slot; };
static Location findChild(std::vector<FX> &chain, unsigned char id) {
  for (int i = 0; i < (int)chain.size(); ++i) {
    if (chain[i].guid[0] == id) return {&chain, i};
    auto nested = findChild(chain[i].children, id);
    if (nested.chain) return nested;
  }
  return {nullptr, -1};
}
static Location locate(int index) {
  auto &chain = index & reasplice::monitoringFX ? monitoring : active->chain;
  if (index & 0x2000000) {
    auto found = findChild(chain, index & 255);
    assert(found.chain); return found;
  }
  int slot = index & ~reasplice::monitoringFX;
  assert(slot >= 0 && slot < (int)chain.size());
  return {&chain, slot};
}
static FX &at(int index) { auto p = locate(index); return p.chain->at(p.slot); }

int main() {
  reasplice::MasterBridgeAPI api{
    [](void *project) -> void * { assert(!project); return active; },
    [](void *track) { assert(track == active); return (int)active->chain.size(); },
    [](void *track) { assert(track == active); return (int)monitoring.size(); },
    [](void *track, int index, const char *key, char *out, int size) {
      assert(track == active);
      auto &fx = at(index);
      std::string value;
      if (!std::strcmp(key, "original_name")) value = fx.name;
      else if (!std::strcmp(key, "container_count")) value = std::to_string(fx.children.size());
      else if (!std::strncmp(key, "container_item.", 15)) {
        int child = std::atoi(key + 15);
        value = std::to_string(0x2000000 | (index & reasplice::monitoringFX) | fx.children.at(child).guid[0]);
      } else return false;
      std::snprintf(out, size, "%s", value.c_str()); return true;
    },
    [](void *, int index) -> const void * { return at(index).guid.data(); },
    [](void *track, const char *, bool rec, int mode) {
      assert(track == active && !rec && mode == -1);
      if (!installed) return -1;
      ++added; active->chain.push_back(bridge); return (int)active->chain.size()-1;
    },
    [](void *src, int index, void *dest, int slot, bool move) {
      assert(src == active && dest == active && move);
      assert(slot == (int)active->chain.size()); // normal master chain, never record FX
      if (!moveWorks) return;
      auto p = locate(index);
      FX item = p.chain->at(p.slot);
      p.chain->erase(p.chain->begin() + p.slot);
      active->chain.push_back(item);
    },
    [](void *, int index, bool offline) { at(index).offline = offline; },
    [](void *, int index, bool enabled) { at(index).enabled = enabled; },
    [](void *, int index, int mode) { assert(mode == 1 && !(index & reasplice::monitoringFX)); shown = index; }
  };
  first.chain = {{"EQ", {1}}, {"Meter", {2}, false}};
  monitoring = {{"Room correction", {3}, false}};
  auto result = reasplice::ensureMasterBridge(api);
  assert(result.error.empty() && result.created && !result.moved && !result.migrated && added == 1);
  assert(first.chain.size() == 3 && first.chain[0].guid[0] == 1 && first.chain[1].guid[0] == 2 && !first.chain[1].enabled);
  assert(shown == 2 && monitoring.size() == 1 && !monitoring[0].enabled);
  result = reasplice::ensureMasterBridge(api);
  assert(result.error.empty() && !result.created && !result.moved && added == 1 && first.chain.size() == 3);
  std::rotate(first.chain.begin(), first.chain.end()-1, first.chain.end());
  first.chain[0].offline = true; first.chain[0].enabled = false;
  result = reasplice::ensureMasterBridge(api);
  assert(result.error.empty() && result.moved && !result.created && added == 1);
  assert(first.chain[0].guid[0] == 1 && first.chain[1].guid[0] == 2 && first.chain.back().guid[0] == 9);
  assert(first.chain.back().enabled && !first.chain.back().offline && !first.chain[1].enabled);

  // A new project gets its own instance; the first project's FX are untouched.
  active = &second;
  result = reasplice::ensureMasterBridge(api);
  assert(result.error.empty() && result.created && added == 2 && second.chain.size() == 1);
  assert(first.chain.size() == 3 && first.chain[1].guid[0] == 2 && !first.chain[1].enabled);

  // Move the legacy monitoring instance, preserving identity and other effects.
  second.chain = {{"Limiter", {4}}};
  monitoring = {{"Room correction", {3}, false}, bridge, {"Meter", {5}}};
  result = reasplice::ensureMasterBridge(api);
  assert(result.error.empty() && result.migrated && result.moved && !result.created && added == 2);
  assert(second.chain.size() == 2 && second.chain.back().guid[0] == 9);
  assert(monitoring.size() == 2 && monitoring[0].guid[0] == 3 && !monitoring[0].enabled && monitoring[1].guid[0] == 5);

  // Existing master wins; any remaining global Bridge copies are bypassed.
  monitoring.push_back({"Container", {6}, true, false, {bridge}});
  result = reasplice::ensureMasterBridge(api);
  assert(result.error.empty() && !result.migrated && !result.created && added == 2);
  assert(!monitoring.back().children[0].enabled && monitoring.back().enabled && monitoring[1].enabled);

  // Containers work both on the project master and in the old monitoring chain.
  second.chain = {{"Container", {7}, true, false, {bridge}}, {"EQ", {8}}};
  monitoring.clear();
  result = reasplice::ensureMasterBridge(api);
  assert(result.error.empty() && result.moved && second.chain.size() == 3 && second.chain[0].children.empty());
  second.chain.clear();
  monitoring = {{"Container", {6}, true, false, {bridge}}};
  result = reasplice::ensureMasterBridge(api);
  assert(result.error.empty() && result.migrated && second.chain.size() == 1 && monitoring[0].children.empty());

  second.chain = {{"EQ", {1}}}; monitoring.clear(); installed = false;
  result = reasplice::ensureMasterBridge(api);
  assert(!result.error.empty() && second.chain.size() == 1 && added == 2);
  second.chain = {bridge, {"Meter", {2}}}; moveWorks = false;
  result = reasplice::ensureMasterBridge(api);
  assert(!result.error.empty() && second.chain.size() == 2);
  second.chain.clear(); monitoring = {bridge};
  result = reasplice::ensureMasterBridge(api);
  assert(!result.error.empty() && monitoring[0].enabled && second.chain.empty());
  std::cout << "Master Bridge checks passed: append, reuse, project isolation, order/state preservation, containers, migration, legacy bypass, missing plugin, failed moves.\n";
}
