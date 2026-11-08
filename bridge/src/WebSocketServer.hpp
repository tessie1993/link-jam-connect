#pragma once

// Small single-threaded HTTP + WebSocket (RFC 6455) server built on the asio
// that ships with Ableton Link. Plain HTTP GETs are served from static roots
// so the bridge can host the JamConnect web app on the same port.

#include "Sha1.hpp"

#include <ableton/platforms/asio/AsioWrapper.hpp>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <deque>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace jamlink
{

class WebSocketServer;

class WsSession : public std::enable_shared_from_this<WsSession>
{
public:
  WsSession(asio::ip::tcp::socket socket, WebSocketServer& server, uint64_t id)
    : mSocket(std::move(socket))
    , mServer(server)
    , mId(id)
  {
    std::error_code ec;
    const auto ep = mSocket.remote_endpoint(ec);
    mRemote = ec ? std::string("?") : ep.address().to_string();
  }

  void start();
  void sendText(const std::string& text) { sendFrame(0x1, text); }
  void close();

  uint64_t id() const { return mId; }
  const std::string& remote() const { return mRemote; }
  bool isOpen() const { return mWsOpen && !mClosed; }

  // Application data attached by the bridge.
  bool authenticated = false;
  std::string name;
  std::string appName;
  double rttMs = 0;

private:
  void readRequest();
  void handleRequest(const std::string& request);
  void serveFile(const std::string& path);
  void writeRaw(std::string data, bool closeAfter);
  void readFrames();
  void processFrames();
  void sendFrame(uint8_t opcode, const std::string& payload);
  void doWrite();
  void shutdown();

  asio::ip::tcp::socket mSocket;
  WebSocketServer& mServer;
  uint64_t mId;
  std::string mRemote;
  asio::streambuf mRequestBuf;
  std::vector<uint8_t> mRx;
  std::array<uint8_t, 8192> mReadChunk{};
  std::string mFragment;
  bool mFragmentActive = false;
  std::deque<std::string> mOutQueue;
  bool mWriting = false;
  bool mCloseAfterWrite = false;
  bool mWsOpen = false;
  bool mClosed = false;
};

class WebSocketServer
{
public:
  using SessionPtr = std::shared_ptr<WsSession>;
  std::function<void(SessionPtr)> onOpen;
  std::function<void(SessionPtr, const std::string&)> onMessage;
  std::function<void(SessionPtr)> onClose;
  std::function<void(const std::string&)> onLog;
  // Dynamic HTTP GET handler, consulted before static files. Return true if handled.
  std::function<bool(const std::string& path, std::string& body, std::string& contentType)> onHttp;

  WebSocketServer(asio::io_context& io, const asio::ip::tcp::endpoint& endpoint)
    : mAcceptor(io)
  {
    mAcceptor.open(endpoint.protocol());
    mAcceptor.set_option(asio::ip::tcp::acceptor::reuse_address(true));
    mAcceptor.bind(endpoint);
    mAcceptor.listen();
  }

  void addStaticRoot(const std::string& dir) { mStaticRoots.push_back(dir); }
  void setMaxMessageBytes(std::size_t n) { mMaxMessageBytes = n; }
  std::size_t maxMessageBytes() const { return mMaxMessageBytes; }
  const std::vector<std::string>& staticRoots() const { return mStaticRoots; }

  void start() { accept(); }

  void log(const std::string& msg)
  {
    if (onLog)
      onLog(msg);
  }

private:
  void accept()
  {
    mAcceptor.async_accept([this](std::error_code ec, asio::ip::tcp::socket socket) {
      if (!ec)
      {
        socket.set_option(asio::ip::tcp::no_delay(true));
        std::make_shared<WsSession>(std::move(socket), *this, ++mNextId)->start();
      }
      accept();
    });
  }

  asio::ip::tcp::acceptor mAcceptor;
  std::vector<std::string> mStaticRoots;
  std::size_t mMaxMessageBytes = 0; // 0 = unlimited; set from config
  uint64_t mNextId = 0;
};

// ---------------------------------------------------------------------------

inline std::string toLower(std::string s)
{
  std::transform(s.begin(), s.end(), s.begin(),
    [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

inline std::string trim(const std::string& s)
{
  const auto b = s.find_first_not_of(" \t\r\n");
  const auto e = s.find_last_not_of(" \t\r\n");
  return b == std::string::npos ? std::string() : s.substr(b, e - b + 1);
}

inline void WsSession::start()
{
  readRequest();
}

inline void WsSession::readRequest()
{
  auto self = shared_from_this();
  asio::async_read_until(
    mSocket, mRequestBuf, "\r\n\r\n", [this, self](std::error_code ec, std::size_t n) {
      if (ec)
      {
        shutdown();
        return;
      }
      std::string all(asio::buffers_begin(mRequestBuf.data()),
        asio::buffers_begin(mRequestBuf.data()) + static_cast<std::ptrdiff_t>(n));
      mRequestBuf.consume(n);
      // Keep any bytes the client already sent after the handshake.
      const auto rest = mRequestBuf.size();
      if (rest > 0)
      {
        const auto* p = static_cast<const uint8_t*>(mRequestBuf.data().data());
        mRx.insert(mRx.end(), p, p + rest);
        mRequestBuf.consume(rest);
      }
      handleRequest(all);
    });
}

inline void WsSession::handleRequest(const std::string& request)
{
  std::istringstream in(request);
  std::string line;
  std::getline(in, line);
  std::istringstream first(line);
  std::string method, target;
  first >> method >> target;

  std::map<std::string, std::string> headers;
  while (std::getline(in, line))
  {
    const auto colon = line.find(':');
    if (colon == std::string::npos)
      continue;
    headers[toLower(trim(line.substr(0, colon)))] = trim(line.substr(colon + 1));
  }

  const bool isUpgrade = toLower(headers["upgrade"]) == "websocket"
                         && headers.count("sec-websocket-key") > 0;
  if (isUpgrade)
  {
    std::string resp = "HTTP/1.1 101 Switching Protocols\r\n"
                       "Upgrade: websocket\r\n"
                       "Connection: Upgrade\r\n"
                       "Sec-WebSocket-Accept: "
                       + webSocketAccept(headers["sec-websocket-key"]) + "\r\n\r\n";
    mWsOpen = true;
    writeRaw(std::move(resp), false);
    if (mServer.onOpen)
      mServer.onOpen(shared_from_this());
    processFrames();
    readFrames();
    return;
  }

  if (method != "GET" && method != "HEAD")
  {
    writeRaw("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n", true);
    return;
  }
  serveFile(target);
}

inline std::string contentType(const std::string& path)
{
  const auto dot = path.rfind('.');
  const std::string ext = dot == std::string::npos ? "" : toLower(path.substr(dot));
  if (ext == ".html" || ext == ".htm")
    return "text/html; charset=utf-8";
  if (ext == ".js" || ext == ".mjs")
    return "text/javascript; charset=utf-8";
  if (ext == ".css")
    return "text/css; charset=utf-8";
  if (ext == ".json")
    return "application/json";
  if (ext == ".png")
    return "image/png";
  if (ext == ".svg")
    return "image/svg+xml";
  if (ext == ".ico")
    return "image/x-icon";
  return "application/octet-stream";
}

inline void WsSession::serveFile(const std::string& target)
{
  std::string path = target.substr(0, target.find_first_of("?#"));
  if (path.empty() || path == "/")
    path = "/index.html";
  if (path.find("..") != std::string::npos || path.find('\\') != std::string::npos)
  {
    writeRaw("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n", true);
    return;
  }
  {
    std::string body, type;
    if (mServer.onHttp && mServer.onHttp(path, body, type))
    {
      writeRaw("HTTP/1.1 200 OK\r\nContent-Type: " + type + "\r\nContent-Length: "
                 + std::to_string(body.size())
                 + "\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n" + body,
        true);
      return;
    }
  }
  for (const auto& root : mServer.staticRoots())
  {
    std::ifstream f(root + path, std::ios::binary);
    if (!f)
      continue;
    std::ostringstream body;
    body << f.rdbuf();
    const std::string data = body.str();
    std::string resp = "HTTP/1.1 200 OK\r\nContent-Type: " + contentType(path)
                       + "\r\nContent-Length: " + std::to_string(data.size())
                       + "\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n" + data;
    writeRaw(std::move(resp), true);
    return;
  }
  const std::string msg = "Not found";
  writeRaw("HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: "
             + std::to_string(msg.size()) + "\r\nConnection: close\r\n\r\n" + msg,
    true);
}

inline void WsSession::readFrames()
{
  auto self = shared_from_this();
  mSocket.async_read_some(
    asio::buffer(mReadChunk), [this, self](std::error_code ec, std::size_t n) {
      if (ec)
      {
        shutdown();
        return;
      }
      mRx.insert(mRx.end(), mReadChunk.begin(), mReadChunk.begin() + static_cast<std::ptrdiff_t>(n));
      processFrames();
      if (!mClosed)
        readFrames();
    });
}

inline void WsSession::processFrames()
{
  const size_t maxMessage = mServer.maxMessageBytes();
  while (!mClosed && mRx.size() >= 2)
  {
    const bool fin = (mRx[0] & 0x80) != 0;
    const uint8_t opcode = mRx[0] & 0x0F;
    const bool masked = (mRx[1] & 0x80) != 0;
    uint64_t len = mRx[1] & 0x7F;
    size_t pos = 2;
    if (len == 126)
    {
      if (mRx.size() < 4)
        return;
      len = (uint64_t(mRx[2]) << 8) | mRx[3];
      pos = 4;
    }
    else if (len == 127)
    {
      if (mRx.size() < 10)
        return;
      len = 0;
      for (int i = 0; i < 8; ++i)
        len = (len << 8) | mRx[2 + static_cast<size_t>(i)];
      pos = 10;
    }
    if (maxMessage && (len > maxMessage || mFragment.size() + len > maxMessage))
    {
      close();
      return;
    }
    const size_t maskPos = pos;
    if (masked)
      pos += 4;
    if (mRx.size() < pos + len)
      return;

    std::string payload(mRx.begin() + static_cast<std::ptrdiff_t>(pos),
      mRx.begin() + static_cast<std::ptrdiff_t>(pos + len));
    if (masked)
    {
      for (size_t i = 0; i < payload.size(); ++i)
        payload[i] = static_cast<char>(payload[i] ^ mRx[maskPos + (i % 4)]);
    }
    mRx.erase(mRx.begin(), mRx.begin() + static_cast<std::ptrdiff_t>(pos + len));

    switch (opcode)
    {
    case 0x0: // continuation
      if (!mFragmentActive)
        break;
      mFragment += payload;
      if (fin)
      {
        mFragmentActive = false;
        if (mServer.onMessage)
          mServer.onMessage(shared_from_this(), mFragment);
        mFragment.clear();
      }
      break;
    case 0x1: // text
      if (fin)
      {
        if (mServer.onMessage)
          mServer.onMessage(shared_from_this(), payload);
      }
      else
      {
        mFragment = payload;
        mFragmentActive = true;
      }
      break;
    case 0x2: // binary: not part of the protocol
      break;
    case 0x8: // close
      sendFrame(0x8, payload.substr(0, 2));
      mCloseAfterWrite = true;
      break;
    case 0x9: // ping
      sendFrame(0xA, payload);
      break;
    default:
      break;
    }
  }
}

inline void WsSession::sendFrame(uint8_t opcode, const std::string& payload)
{
  if (mClosed || !mWsOpen)
    return;
  std::string frame;
  frame.push_back(static_cast<char>(0x80 | opcode));
  const uint64_t len = payload.size();
  if (len < 126)
  {
    frame.push_back(static_cast<char>(len));
  }
  else if (len <= 0xFFFF)
  {
    frame.push_back(126);
    frame.push_back(static_cast<char>((len >> 8) & 0xFF));
    frame.push_back(static_cast<char>(len & 0xFF));
  }
  else
  {
    frame.push_back(127);
    for (int i = 7; i >= 0; --i)
      frame.push_back(static_cast<char>((len >> (i * 8)) & 0xFF));
  }
  frame += payload;
  writeRaw(std::move(frame), false);
}

inline void WsSession::writeRaw(std::string data, bool closeAfter)
{
  if (mClosed)
    return;
  if (closeAfter)
    mCloseAfterWrite = true;
  mOutQueue.push_back(std::move(data));
  if (!mWriting)
    doWrite();
}

inline void WsSession::doWrite()
{
  if (mOutQueue.empty())
  {
    mWriting = false;
    if (mCloseAfterWrite)
      shutdown();
    return;
  }
  mWriting = true;
  auto self = shared_from_this();
  asio::async_write(mSocket, asio::buffer(mOutQueue.front()),
    [this, self](std::error_code ec, std::size_t) {
      if (ec)
      {
        shutdown();
        return;
      }
      mOutQueue.pop_front();
      doWrite();
    });
}

inline void WsSession::close()
{
  if (mClosed)
    return;
  if (mWsOpen)
  {
    sendFrame(0x8, std::string("\x03\xE8", 2));
    mCloseAfterWrite = true;
  }
  else
  {
    shutdown();
  }
}

inline void WsSession::shutdown()
{
  if (mClosed)
    return;
  mClosed = true;
  std::error_code ec;
  mSocket.shutdown(asio::ip::tcp::socket::shutdown_both, ec);
  mSocket.close(ec);
  if (mWsOpen && mServer.onClose)
    mServer.onClose(shared_from_this());
}

} // namespace jamlink
