// jamlink-bridge: an Ableton Link peer that speaks the JamConnect protocol.
//
// Ableton Live sees an ordinary Link peer (built from the Ableton Link sources).
// JamConnect apps connect over ws://<bind>:<port> and get the Link timeline,
// Link-style clock synchronisation and control over tempo / start-stop.
// See ../../PROTOCOL.md.

#include <ableton/Link.hpp>

#include "WebSocketServer.hpp"

#include "../third_party/json.hpp"

#include <atomic>
#include <chrono>
#include <csignal>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <map>
#include <set>
#include <string>

using json = nlohmann::json;
using namespace std::chrono;

namespace
{

struct Options
{
  std::string bind = "127.0.0.1";
  unsigned short port = 20809;
  std::string token;
  double bpm = 120.0;
  double quantum = 4.0;
  bool startStopSync = true;
  bool quiet = false;
  std::vector<std::string> staticRoots;
};

void printUsage()
{
  std::cout
    << "jamlink-bridge - JamConnect <-> Ableton Link bridge\n\n"
       "  --port <n>        WebSocket/HTTP port (default 20809)\n"
       "  --bind <addr>     listen address (default 127.0.0.1, use 0.0.0.0 for LAN)\n"
       "  --token <t>       require this JamConnect auth token\n"
       "  --bpm <bpm>       initial tempo when no Link session exists (default 120)\n"
       "  --quantum <q>     quantum for phase/launch (default 4)\n"
       "  --static <dir>    serve files from dir over HTTP (repeatable)\n"
       "  --no-start-stop   don't enable Link start/stop sync\n"
       "  --quiet           no status line\n";
}

bool parseArgs(int argc, char** argv, Options& o)
{
  for (int i = 1; i < argc; ++i)
  {
    const std::string a = argv[i];
    auto next = [&](const char* name) -> std::string {
      if (i + 1 >= argc)
        throw std::runtime_error(std::string("missing value for ") + name);
      return argv[++i];
    };
    if (a == "--port")
      o.port = static_cast<unsigned short>(std::stoi(next("--port")));
    else if (a == "--bind")
      o.bind = next("--bind");
    else if (a == "--token")
      o.token = next("--token");
    else if (a == "--bpm")
      o.bpm = std::stod(next("--bpm"));
    else if (a == "--quantum")
      o.quantum = std::stod(next("--quantum"));
    else if (a == "--static")
      o.staticRoots.push_back(next("--static"));
    else if (a == "--no-start-stop")
      o.startStopSync = false;
    else if (a == "--quiet")
      o.quiet = true;
    else if (a == "-h" || a == "--help")
    {
      printUsage();
      return false;
    }
    else
      throw std::runtime_error("unknown argument " + a);
  }
  return true;
}

double nowMs(const ableton::Link& link)
{
  return static_cast<double>(link.clock().micros().count()) / 1000.0;
}

class Bridge
{
public:
  Bridge(asio::io_context& io, const Options& opts)
    : mIo(io)
    , mOpts(opts)
    , mLink(opts.bpm)
    , mServer(io, asio::ip::tcp::endpoint(asio::ip::make_address(opts.bind), opts.port))
    , mStateTimer(io)
    , mPingTimer(io)
    , mStatusTimer(io)
    , mSessionId("LINK-" + std::to_string(opts.port))
  {
    for (const auto& r : opts.staticRoots)
      mServer.addStaticRoot(r);

    mServer.onOpen = [this](auto s) { onOpen(s); };
    mServer.onMessage = [this](auto s, const std::string& m) { onMessage(s, m); };
    mServer.onClose = [this](auto s) { onClose(s); };

    // Link callbacks arrive on a Link thread; hop onto the io thread.
    mLink.setTempoCallback([this](double bpm) {
      asio::post(mIo, [this, bpm] { onLinkTempo(bpm); });
    });
    mLink.setStartStopCallback([this](bool playing) {
      asio::post(mIo, [this, playing] { onLinkStartStop(playing); });
    });
    mLink.setNumPeersCallback([this](std::size_t n) {
      asio::post(mIo, [this, n] {
        log("Link peers: " + std::to_string(n));
        broadcastState();
      });
    });

    mLink.enableStartStopSync(opts.startStopSync);
    mLink.enable(true);
  }

  void start()
  {
    mServer.start();
    scheduleState();
    schedulePing();
    if (!mOpts.quiet)
      scheduleStatus();
    std::cout << "jamlink-bridge listening on ws://" << mOpts.bind << ":" << mOpts.port
              << "  (session " << mSessionId << ", Link enabled, start/stop sync "
              << (mOpts.startStopSync ? "on" : "off") << ")" << std::endl;
    if (!mOpts.staticRoots.empty())
      std::cout << "web app: http://" << (mOpts.bind == "0.0.0.0" ? "127.0.0.1" : mOpts.bind)
                << ":" << mOpts.port << "/" << std::endl;
  }

  void stop()
  {
    mLink.enable(false);
  }

private:
  using SessionPtr = std::shared_ptr<jamlink::WsSession>;

  // -------------------------------------------------------------------------
  // Link state

  json linkState()
  {
    const auto now = mLink.clock().micros();
    const auto state = mLink.captureAppSessionState();
    const double q = mOpts.quantum;
    const auto playTime = state.timeForIsPlaying();
    return json{
      {"type", "LINK_STATE"},
      {"tempo", state.tempo()},
      {"beat", state.beatAtTime(now, q)},
      {"atUs", static_cast<double>(now.count())},
      {"quantum", q},
      {"phase", state.phaseAtTime(now, q)},
      {"isPlaying", state.isPlaying()},
      {"playTimeUs", static_cast<double>(playTime.count())},
      {"playBeat", state.beatAtTime(playTime, q)},
      {"numPeers", mLink.numPeers()},
      {"linkEnabled", mLink.isEnabled()},
      {"startStopSync", mLink.isStartStopSyncEnabled()},
      {"source", "bridge"},
    };
  }

  // JamConnect transport message so plain Tone.js JamConnect apps follow Link.
  json legacyTransport(const std::string& what)
  {
    const auto now = mLink.clock().micros();
    const auto state = mLink.captureAppSessionState();
    json m{{"type", "TRANSPORT_STATE"}, {"state", what}, {"bpm", state.tempo()},
      {"swing", 0}, {"hostAudioTime", nowMs(mLink) / 1000.0}, {"origin", "link"}};
    if (what == "started")
    {
      const auto playTime = state.timeForIsPlaying();
      const double deltaSec =
        static_cast<double>((playTime - now).count()) / 1e6;
      m["seconds"] = deltaSec > 0 ? 0.0 : -deltaSec;
      m["delaySec"] = deltaSec > 0 ? deltaSec : 0.0;
    }
    else
    {
      m["seconds"] = 0;
      m["ticks"] = 0;
    }
    return m;
  }

  void onLinkTempo(double bpm)
  {
    std::ostringstream s;
    s << "Link tempo " << std::fixed << std::setprecision(2) << bpm;
    log(s.str());
    broadcastState();
    broadcast(legacyTransport("bpmchanged"));
  }

  void onLinkStartStop(bool playing)
  {
    log(std::string("Link transport ") + (playing ? "PLAY" : "STOP"));
    broadcastState();
    broadcast(legacyTransport(playing ? "started" : "stopped"));
  }

  void setTempo(double bpm)
  {
    if (!(bpm >= 20.0 && bpm <= 999.0))
      return;
    auto state = mLink.captureAppSessionState();
    state.setTempo(bpm, mLink.clock().micros());
    mLink.commitAppSessionState(state);
  }

  void setPlaying(bool playing, double quantum)
  {
    auto state = mLink.captureAppSessionState();
    const auto now = mLink.clock().micros();
    if (playing)
      state.setIsPlayingAndRequestBeatAtTime(true, now, 0.0, quantum);
    else
      state.setIsPlaying(false, now);
    mLink.commitAppSessionState(state);
  }

  void requestBeat(double beat, double quantum)
  {
    auto state = mLink.captureAppSessionState();
    state.requestBeatAtTime(beat, mLink.clock().micros(), quantum);
    mLink.commitAppSessionState(state);
  }

  // -------------------------------------------------------------------------
  // Sessions

  void onOpen(SessionPtr s)
  {
    mSessions[s->id()] = s;
    log("client #" + std::to_string(s->id()) + " connected from " + s->remote());
    // Unauthenticated sockets get 6 s, like JamConnect hosts.
    auto timer = std::make_shared<asio::steady_timer>(mIo, seconds(6));
    timer->async_wait([this, s, timer](std::error_code ec) {
      if (!ec && s->isOpen() && !s->authenticated)
      {
        send(s, {{"type", "AUTH_REJECTED"}, {"reason", "Authentication timeout"}});
        s->close();
      }
    });
  }

  void onClose(SessionPtr s)
  {
    mSessions.erase(s->id());
    if (s->authenticated)
    {
      log("client #" + std::to_string(s->id()) + " (" + s->name + ") left");
      broadcastPeerList();
    }
  }

  void onMessage(SessionPtr s, const std::string& text)
  {
    json msg;
    try
    {
      msg = json::parse(text);
    }
    catch (const std::exception&)
    {
      return;
    }
    if (!msg.is_object() || !msg.contains("type") || !msg["type"].is_string())
      return;
    const std::string type = msg["type"];

    if (!s->authenticated)
    {
      const std::string token = msg.value("authToken", std::string());
      if (type == "AUTH_HELLO" && (mOpts.token.empty() || token == mOpts.token))
      {
        s->authenticated = true;
        s->name = msg.value("name", "client-" + std::to_string(s->id()));
        s->appName = msg.value("appName", std::string("unknown"));
        completeAuth(s);
      }
      else
      {
        send(s, {{"type", "AUTH_REJECTED"}, {"reason", "Invalid session auth token"}});
        s->close();
      }
      return;
    }

    if (type == "LINK_PING")
    {
      // Link measurement exchange (see ableton/link/PingResponder.hpp).
      send(s, {{"type", "LINK_PONG"},
                {"gt", static_cast<double>(mLink.clock().micros().count())},
                {"ht", msg.value("ht", 0.0)}, {"pgt", msg.value("pgt", 0.0)}});
    }
    else if (type == "PING")
    {
      send(s, {{"type", "PONG"}, {"hostSendTime", msg.value("hostSendTime", 0.0)},
                {"guestReceiveTime", nowMs(mLink)}});
    }
    else if (type == "PONG")
    {
      const double now = nowMs(mLink);
      const double sent = msg.value("hostSendTime", now);
      const double rtt = std::max(0.0, now - sent);
      const double offset = msg.value("guestReceiveTime", now) - (sent + rtt / 2.0);
      s->rttMs = rtt;
      send(s, {{"type", "CLOCK_SYNC"}, {"rtt", std::lround(rtt)}, {"timeOffset", offset}});
    }
    else if (type == "CLOCK_SYNC" || type == "LINK_PONG" || type == "AUTH_HELLO")
    {
    }
    else if (type == "LINK_GET_STATE")
    {
      send(s, linkState());
    }
    else if (type == "LINK_SET_TEMPO")
    {
      setTempo(msg.value("bpm", 0.0));
      broadcastState();
    }
    else if (type == "LINK_SET_PLAYING")
    {
      setPlaying(msg.value("playing", false), msg.value("quantum", mOpts.quantum));
      broadcastState();
    }
    else if (type == "LINK_REQUEST_BEAT")
    {
      requestBeat(msg.value("beat", 0.0), msg.value("quantum", mOpts.quantum));
      broadcastState();
    }
    else if (type == "LINK_ENABLE")
    {
      mLink.enable(msg.value("enabled", true));
      broadcastState();
    }
    else if (type == "LINK_START_STOP_SYNC")
    {
      mLink.enableStartStopSync(msg.value("enabled", true));
      broadcastState();
    }
    else if (type == "TRANSPORT_STATE")
    {
      // Legacy JamConnect transport -> Link. The Link callback re-broadcasts
      // the resulting state to everyone, so we don't relay the original.
      const std::string st = msg.value("state", std::string());
      if (msg.contains("bpm") && msg["bpm"].is_number())
      {
        const double bpm = msg["bpm"];
        if (std::abs(bpm - mLink.captureAppSessionState().tempo()) > 0.001)
          setTempo(bpm);
      }
      if (st == "started")
        setPlaying(true, mOpts.quantum);
      else if (st == "stopped")
        setPlaying(false, mOpts.quantum);
      broadcastState();
    }
    else
    {
      // Musical / app traffic: hub relay to every other client.
      if (!msg.contains("from"))
        msg["from"] = s->name;
      broadcast(msg, s->id());
    }
  }

  void completeAuth(SessionPtr s)
  {
    const auto state = mLink.captureAppSessionState();
    send(s, {{"type", "AUTH_OK"}, {"sessionId", mSessionId},
              {"peerId", "bridge-" + std::to_string(s->id())},
              {"permissions",
                {{"syncTransport", true}, {"syncMasterSettings", true},
                  {"syncPattern", true}, {"syncDeviceParameterChange", true},
                  {"syncMidi", true}}},
              {"hostAppName", "jamlink-bridge"}, {"hostTime", nowMs(mLink)},
              {"bpm", state.tempo()}, {"swing", 0},
              {"transportState", state.isPlaying() ? "started" : "stopped"},
              {"seconds", 0}, {"link", linkState()}});
    send(s, linkState());
    sendPing(s);
    log("client #" + std::to_string(s->id()) + " authenticated as " + s->name + " ("
        + s->appName + ")");
    broadcastPeerList();
  }

  void broadcastPeerList()
  {
    json peers = json::array();
    for (auto& [id, s] : mSessions)
    {
      if (s->authenticated)
        peers.push_back({{"id", "bridge-" + std::to_string(id)}, {"name", s->name},
          {"appName", s->appName}, {"rtt", std::lround(s->rttMs)}});
    }
    broadcast({{"type", "PEER_LIST"}, {"peers", peers}, {"linkPeers", mLink.numPeers()}});
  }

  void send(const SessionPtr& s, const json& m)
  {
    if (s->isOpen())
      s->sendText(m.dump());
  }

  void broadcast(const json& m, uint64_t except = 0)
  {
    const std::string text = m.dump();
    for (auto& [id, s] : mSessions)
    {
      if (id != except && s->authenticated && s->isOpen())
        s->sendText(text);
    }
  }

  void broadcastState() { broadcast(linkState()); }

  void sendPing(const SessionPtr& s)
  {
    send(s, {{"type", "PING"}, {"hostSendTime", nowMs(mLink)}});
  }

  // -------------------------------------------------------------------------
  // Timers

  void scheduleState()
  {
    mStateTimer.expires_after(milliseconds(100));
    mStateTimer.async_wait([this](std::error_code ec) {
      if (ec)
        return;
      broadcastState();
      scheduleState();
    });
  }

  void schedulePing()
  {
    mPingTimer.expires_after(seconds(2));
    mPingTimer.async_wait([this](std::error_code ec) {
      if (ec)
        return;
      for (auto& [id, s] : mSessions)
        if (s->authenticated)
          sendPing(s);
      schedulePing();
    });
  }

  void scheduleStatus()
  {
    mStatusTimer.expires_after(milliseconds(250));
    mStatusTimer.async_wait([this](std::error_code ec) {
      if (ec)
        return;
      const auto now = mLink.clock().micros();
      const auto st = mLink.captureAppSessionState();
      const double phase = st.phaseAtTime(now, mOpts.quantum);
      std::string bar;
      for (int i = 0; i < static_cast<int>(std::ceil(mOpts.quantum)); ++i)
        bar += (i <= phase ? 'X' : '-');
      size_t clients = 0;
      for (auto& [id, s] : mSessions)
        clients += s->authenticated ? 1 : 0;
      std::cout << "\rtempo " << std::fixed << std::setprecision(2) << st.tempo()
                << " | beat " << std::setw(9) << st.beatAtTime(now, mOpts.quantum)
                << " | " << bar << " | " << (st.isPlaying() ? "PLAY" : "stop")
                << " | link peers " << mLink.numPeers() << " | jam clients " << clients
                << "   " << std::flush;
      scheduleStatus();
    });
  }

  void log(const std::string& line)
  {
    std::cout << "\r" << std::string(100, ' ') << "\r[bridge] " << line << std::endl;
  }

  asio::io_context& mIo;
  Options mOpts;
  ableton::Link mLink;
  jamlink::WebSocketServer mServer;
  asio::steady_timer mStateTimer;
  asio::steady_timer mPingTimer;
  asio::steady_timer mStatusTimer;
  std::string mSessionId;
  std::map<uint64_t, SessionPtr> mSessions;
};

} // namespace

int main(int argc, char** argv)
{
  Options opts;
  try
  {
    if (!parseArgs(argc, argv, opts))
      return 0;
  }
  catch (const std::exception& e)
  {
    std::cerr << e.what() << "\n\n";
    printUsage();
    return 1;
  }

  try
  {
    asio::io_context io;
    Bridge bridge(io, opts);
    asio::signal_set signals(io, SIGINT, SIGTERM);
    signals.async_wait([&](std::error_code, int) {
      std::cout << "\nshutting down" << std::endl;
      bridge.stop();
      io.stop();
    });
    bridge.start();
    io.run();
  }
  catch (const std::exception& e)
  {
    std::cerr << "jamlink-bridge: " << e.what() << std::endl;
    return 1;
  }
  return 0;
}
