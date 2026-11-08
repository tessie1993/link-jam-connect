// linkpeer: headless Ableton Link peer used to test the bridge without Live.
// Prints tempo/beat/phase/play state as JSON lines so tests can parse it.
//
//   linkpeer --bpm B [--seconds N] [--tempo-at S:BPM] [--play-at S] [--stop-at S]

#include <ableton/Link.hpp>

#include <chrono>
#include <iomanip>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

int main(int argc, char** argv)
{
  double seconds = 10, bpm = 0, quantum = 4;
  std::vector<std::pair<double, double>> tempoChanges;
  double playAt = -1, stopAt = -1;
  for (int i = 1; i + 1 < argc; i += 2)
  {
    const std::string a = argv[i], v = argv[i + 1];
    if (a == "--seconds")
      seconds = std::stod(v);
    else if (a == "--bpm")
      bpm = std::stod(v);
    else if (a == "--play-at")
      playAt = std::stod(v);
    else if (a == "--stop-at")
      stopAt = std::stod(v);
    else if (a == "--tempo-at")
    {
      const auto c = v.find(':');
      tempoChanges.emplace_back(std::stod(v.substr(0, c)), std::stod(v.substr(c + 1)));
    }
  }

  if (!(bpm >= 20 && bpm <= 999))
  {
    std::cerr << "linkpeer: --bpm <20..999> is required" << std::endl;
    return 1;
  }

  ableton::Link link(bpm);
  link.enableStartStopSync(true);
  link.enable(true);

  const auto t0 = std::chrono::steady_clock::now();
  bool played = false, stopped = false;
  while (true)
  {
    const double el =
      std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    if (el > seconds)
      break;

    for (auto& tc : tempoChanges)
    {
      if (tc.first >= 0 && el >= tc.first)
      {
        auto st = link.captureAppSessionState();
        st.setTempo(tc.second, link.clock().micros());
        link.commitAppSessionState(st);
        tc.first = -1;
      }
    }
    if (playAt >= 0 && !played && el >= playAt)
    {
      auto st = link.captureAppSessionState();
      st.setIsPlayingAndRequestBeatAtTime(true, link.clock().micros(), 0, quantum);
      link.commitAppSessionState(st);
      played = true;
    }
    if (stopAt >= 0 && !stopped && el >= stopAt)
    {
      auto st = link.captureAppSessionState();
      st.setIsPlaying(false, link.clock().micros());
      link.commitAppSessionState(st);
      stopped = true;
    }

    const auto now = link.clock().micros();
    const auto st = link.captureAppSessionState();
    std::cout << std::fixed << std::setprecision(4) << "{\"t\":" << el
              << ",\"clockUs\":" << now.count() << ",\"tempo\":" << st.tempo()
              << ",\"beat\":" << st.beatAtTime(now, quantum)
              << ",\"phase\":" << st.phaseAtTime(now, quantum)
              << ",\"playing\":" << (st.isPlaying() ? "true" : "false")
              << ",\"peers\":" << link.numPeers() << "}" << std::endl;
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
  }
  link.enable(false);
  return 0;
}
