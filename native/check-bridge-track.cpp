// Offline checks; never load a plugin or touch a running REAPER instance.
#include "bridge-track.h"
#include <cassert>
#include <iostream>
#include <memory>
#include <map>

struct FX {
  std::string name;
  std::array<unsigned char,16> guid;
  bool enabled = true, offline = false;
  std::vector<FX> children{};
};
struct Track {
  std::vector<FX> chain, input;
  std::string name, tag, guid;
  std::map<std::string, double> values{{"D_VOL", 1}, {"B_SHOWINTCP", 1}, {"B_SHOWINMIXER", 1}};
};
struct Project { Track master; std::vector<std::unique_ptr<Track>> tracks; };
static Track *newTrack(Project &project, const std::string &tag = "") {
  auto t = std::make_unique<Track>(); t->tag = tag;
  t->name = "Splice Bridge"; t->guid = "track-" + std::to_string(project.tracks.size());
  auto *ptr = t.get(); project.tracks.push_back(std::move(t)); return ptr;
}
static Project first, second;
static Project *active = &first;
static std::vector<FX> &monitoring = first.master.input;
static bool installed, moveWorks, enableWorks, insertWorks, tagWorks;
static int added, shown, offlineCalls, failedOfflineID, failedOnlineID, missingGuidID, nextID;
static std::vector<std::string> events;
static FX bridge(int id = 9) { return {"VST3i: Splice Bridge (Splice)", {static_cast<unsigned char>(id)}}; }
struct Location { std::vector<FX> *chain; int slot; };
static Location locate(void *track, int index) {
  auto *chain = index & reasplice::monitoringFX ? &static_cast<Track *>(track)->input : &static_cast<Track *>(track)->chain;
  if (!(index & 0x2000000)) return {chain, index & ~reasplice::monitoringFX};
  int address = index & 0xffffff;
  int slot = address % (chain->size() + 1) - 1;
  address /= chain->size() + 1;
  while (address) {
    chain = &chain->at(slot).children;
    if (address <= (int)chain->size() + 1) return {chain, address - 1};
    slot = address % (chain->size() + 1) - 1;
    address /= chain->size() + 1;
  }
  return {chain, slot};
}
static FX &at(void *track, int index) { auto p = locate(track, index); return p.chain->at(p.slot); }
static long long addressOf(std::vector<FX> &chain, const FX *target, long long stride, long long base = 0) {
  for (int slot = 0; slot < (int)chain.size(); ++slot) {
    long long address = base + (slot + 1) * stride;
    if (&chain[slot] == target) return address;
    long long child = addressOf(chain[slot].children, target, stride * (chain.size() + 1), address);
    if (child) return child;
  }
  return 0;
}
static void reset() {
  first = Project{}; second = Project{}; active = &first;
  installed = moveWorks = enableWorks = insertWorks = tagWorks = true;
  added = offlineCalls = 0; shown = -1; failedOfflineID = failedOnlineID = missingGuidID = -1; nextID = 90;
  events.clear();
}
static auto makeAPI() {
  return reasplice::BridgeAPI{
    [](void *project) -> void * { return &(project ? static_cast<Project *>(project) : active)->master; },
    [](int index, char *, int) -> void * { return index == 0 ? &first : index == 1 ? &second : nullptr; },
    [](void *track) { return (int)static_cast<Track *>(track)->chain.size(); },
    [](void *track) { return (int)static_cast<Track *>(track)->input.size(); },
    [](void *track, int index, const char *key, char *out, int size) {
      auto &fx = at(track, index);
      std::string value;
      if (!std::strcmp(key, "original_name")) value = fx.name;
      else if (!std::strcmp(key, "container_count")) value = std::to_string(fx.children.size());
      else if (!std::strncmp(key, "container_item.", 15)) {
        int child = std::atoi(key + 15);
        auto &chain = index & reasplice::monitoringFX ? static_cast<Track *>(track)->input : static_cast<Track *>(track)->chain;
        value = std::to_string(0x2000000 | (index & reasplice::monitoringFX) | addressOf(chain, &fx.children.at(child), 1));
      } else return false;
      std::snprintf(out, size, "%s", value.c_str()); return true;
    },
    [](void *track, int index) -> const void * {
      auto &fx = at(track, index); return fx.guid[0] == missingGuidID ? nullptr : fx.guid.data();
    },
    [](void *track, const char *, bool rec, int mode) {
      assert(!rec && mode == -1);
      auto &chain = static_cast<Track *>(track)->chain;
      if (!installed) return -1;
      ++added; chain.push_back(bridge(nextID++));
      events.push_back("add"); return (int)chain.size()-1;
    },
    [](void *src, int index, void *dest, int slot, bool move) {
      assert(move);
      if (!moveWorks) return;
      auto source = locate(src, index), destination = locate(dest, slot);
      FX item = source.chain->at(source.slot);
      source.chain->erase(source.chain->begin() + source.slot);
      if (source.chain == destination.chain && source.slot < destination.slot) --destination.slot;
      destination.chain->insert(destination.chain->begin() + destination.slot, item);
    },
    [](void *track, int index) {
      auto p = locate(track, index); p.chain->erase(p.chain->begin() + p.slot); return true;
    },
    [](void *track, int index) { return at(track, index).offline; },
    [](void *track, int index) { return at(track, index).enabled; },
    [](void *track, int index, bool offline) {
      auto &fx = at(track, index); ++offlineCalls;
      events.push_back(std::to_string(fx.guid[0]) + (offline ? ":offline" : ":online"));
      if ((offline && fx.guid[0] == failedOfflineID) || (!offline && fx.guid[0] == failedOnlineID)) return;
      fx.offline = offline;
    },
    [](void *track, int index, bool enabled) { if (enableWorks) at(track, index).enabled = enabled; },
    [](void *, int index, int mode) { assert(mode == 1 && !(index & reasplice::monitoringFX)); shown = index; },
    [](void *p) { return (int)(p ? static_cast<Project *>(p) : active)->tracks.size(); },
    [](void *p, int i) -> void * { return (p ? static_cast<Project *>(p) : active)->tracks.at(i).get(); },
    [](int i, bool defaults) { assert(!defaults); if (insertWorks) { newTrack(*active); std::rotate(active->tracks.begin()+i, active->tracks.end()-1, active->tracks.end()); } },
    [](void *t) { auto &ts=active->tracks; ts.erase(std::find_if(ts.begin(), ts.end(), [t](auto &v) { return v.get()==t; })); },
    [](void *t, const char *key, char *value, bool set) {
      auto *track = static_cast<Track *>(t);
      std::string *field = !std::strcmp(key,"P_NAME") ? &track->name : !std::strcmp(key,reasplice::bridgeTrackTag) ? &track->tag : !std::strcmp(key,"GUID") ? &track->guid : nullptr;
      if (!field || (set && !tagWorks)) return false;
      if (set) *field = value; else std::strcpy(value, field->c_str()); return true;
    },
    [](void *t, const char *key) { return static_cast<Track *>(t)->values[key]; },
    [](void *t, const char *key, double value) { static_cast<Track *>(t)->values[key]=value; return true; },
    [](bool) {}
  };
}

int main() {
  auto api = makeAPI();
  reset();
  first.master.chain = {{"EQ", {1}}, {"Meter", {2}, false}, {"Splice Sounds (Splice)", {3}}};
  monitoring = {{"Room correction", {4}, false}};
  auto *unrelated = newTrack(first); unrelated->chain = {{"Synth", {5}}};
  auto result = reasplice::ensureBridgeTrack(api);
  auto *track = static_cast<Track *>(result.track);
  assert(result.error.empty() && result.trackCreated && result.created && track != unrelated);
  assert(first.tracks.size() == 2 && track == first.tracks[0].get());
  assert(track->tag == "1" && track->name == "Splice Bridge" && track->chain.size() == 1);
  assert(track->values["B_SHOWINTCP"] == 0 && track->values["B_SHOWINMIXER"] == 0);
  assert(track->values["B_SOLO_DEFEAT"] == 1 && track->values["B_MAINSEND"] == 1 && track->values["I_RECARM"] == 0);
  assert(first.master.chain.size() == 3 && !first.master.chain[1].enabled && !first.master.chain[2].offline);
  assert(monitoring.size() == 1 && !monitoring[0].enabled && shown == -1);
  track->name = "My previews"; track->values["D_VOL"] = .25; track->chain.push_back({"Meter", {6}});
  std::reverse(first.tracks.begin(), first.tracks.end()); events.clear();
  result = reasplice::ensureBridgeTrack(api, false);
  assert(result.error.empty() && !result.created && !result.trackCreated && result.track == track && result.recycled);
  assert(track->values["D_VOL"] == .25 && track->name == "My previews" && track->chain[1].guid[0] == 6);
  assert((events == std::vector<std::string>{"90:offline", "90:online"}));

  active = &second; events.clear(); shown = -1;
  result = reasplice::ensureBridgeTrack(api, false);
  assert(result.error.empty() && result.trackCreated && result.created && shown == -1);
  assert((events == std::vector<std::string>{"90:offline", "add"}));
  assert(track->chain[0].offline);
  auto *secondTrack = static_cast<Track *>(result.track);
  active = &first; events.clear();
  result = reasplice::ensureBridgeTrack(api, false);
  assert(result.error.empty() && result.track == track && !result.created);
  assert((events == std::vector<std::string>{"91:offline", "90:online"}));
  assert(secondTrack->chain[0].offline && track->values["D_VOL"] == .25);

  // Legacy master migration retains identity and all unrelated effects.
  reset(); first.master.chain = {{"Limiter", {1}}, bridge(), {"Meter", {2}, false}};
  result = reasplice::ensureBridgeTrack(api);
  track = static_cast<Track *>(result.track);
  assert(result.error.empty() && result.migrated && !result.created && added == 0);
  assert(track->chain[0].guid[0] == 9 && !track->chain[0].offline);
  assert(first.master.chain.size() == 2 && first.master.chain[0].guid[0] == 1 && !first.master.chain[1].enabled);

  // Nested monitoring migration, plus competing normal/input/master instances.
  reset(); monitoring = {{"Container", {10}, true, false, {bridge(11), {"Meter", {12}}}}, {"Room", {13}}};
  second.master.chain = {bridge(21), {"Splice Sounds (Splice)", {22}}};
  auto *competitor = newTrack(second); competitor->chain = {bridge(23)}; competitor->input = {bridge(24)};
  result = reasplice::ensureBridgeTrack(api);
  track = static_cast<Track *>(result.track);
  assert(result.error.empty() && result.migrated && result.offlined == 3 && track->chain[0].guid[0] == 11);
  assert(monitoring[0].children.size() == 1 && monitoring[0].children[0].guid[0] == 12);
  assert(second.master.chain[0].offline && !second.master.chain[1].offline && competitor->chain[0].offline && competitor->input[0].offline);

  // The marked track wins over legacy instances; nested Bridge is brought out.
  reset(); track = newTrack(first,"1"); track->chain = {{"Container",{1},true,false,{bridge(2)}}};
  first.master.chain = {bridge(3)}; monitoring = {bridge(4)};
  result = reasplice::ensureBridgeTrack(api);
  assert(result.error.empty() && result.moved && !result.trackCreated && track->chain[0].guid[0] == 2);
  assert(first.master.chain[0].offline && monitoring[0].offline);
  // A duplicated empty marker does not steal the existing Bridge track.
  newTrack(first,"1"); std::reverse(first.tracks.begin(),first.tracks.end());
  assert(reasplice::findBridgeTrack(api) == track);

  // Failed setup restores plugin location, settings and competitor state; newly
  // allocated empty tracks are deleted. Include nested address recalculation.
  for (int failure = 0; failure < 7; ++failure) {
    reset(); first.master.chain = {{"Container",{10},true,false,{bridge(11),{"Meter",{12}}}},{"Limiter",{13}}};
    first.master.chain[0].children[0].enabled = false;
    second.master.chain = {bridge(21)};
    if (failure == 0) moveWorks = false;
    if (failure == 1) failedOnlineID = 11;
    if (failure == 2) enableWorks = false;
    if (failure == 3) failedOfflineID = 21;
    if (failure == 4) failedOfflineID = 11;
    if (failure == 5) insertWorks = false;
    if (failure == 6) tagWorks = false;
    result = reasplice::ensureBridgeTrack(api);
    assert(!result.error.empty() && first.tracks.empty());
    assert(first.master.chain.size() == 2 && first.master.chain[0].children.size() == 2);
    assert(first.master.chain[0].children[0].guid[0] == 11 && !first.master.chain[0].children[0].enabled);
    assert(!second.master.chain[0].offline);
    if (failure != 1) assert(!first.master.chain[0].children[0].offline);
    else assert(result.error.find("could not be restored") != std::string::npos);
  }
  // Missing plugins and failed identity checks do not leave empty tracks behind.
  reset(); installed = false; second.master.chain = {bridge(21)};
  result = reasplice::ensureBridgeTrack(api);
  assert(!result.error.empty() && first.tracks.empty() && !second.master.chain[0].offline);
  reset(); missingGuidID = 90;
  result = reasplice::ensureBridgeTrack(api);
  assert(!result.error.empty() && first.tracks.empty());
  reset(); first.master.chain = {bridge(9)}; missingGuidID = 9;
  result = reasplice::ensureBridgeTrack(api);
  assert(!result.error.empty() && first.tracks.empty() && !first.master.chain[0].offline);
  reset(); api.trackString = nullptr;
  result = reasplice::ensureBridgeTrack(api);
  assert(!result.error.empty() && first.tracks.empty());
  std::cout << "Bridge track checks passed: creation, identity/reuse, fader preservation, project handoff, containers, migration and rollback.\n";
}
