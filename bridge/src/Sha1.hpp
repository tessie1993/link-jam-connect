#pragma once

#include <array>
#include <cstdint>
#include <string>

// Minimal SHA-1 + Base64, only used for the RFC 6455 WebSocket handshake.
namespace jamlink
{

inline std::array<uint8_t, 20> sha1(const std::string& input)
{
  uint32_t h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476,
           h4 = 0xC3D2E1F0;

  std::string msg = input;
  const uint64_t bitLen = static_cast<uint64_t>(input.size()) * 8;
  msg.push_back(static_cast<char>(0x80));
  while (msg.size() % 64 != 56)
  {
    msg.push_back(0);
  }
  for (int i = 7; i >= 0; --i)
  {
    msg.push_back(static_cast<char>((bitLen >> (i * 8)) & 0xFF));
  }

  auto rol = [](uint32_t v, int n) { return (v << n) | (v >> (32 - n)); };

  for (size_t chunk = 0; chunk < msg.size(); chunk += 64)
  {
    uint32_t w[80];
    for (int i = 0; i < 16; ++i)
    {
      w[i] = (uint32_t(uint8_t(msg[chunk + i * 4])) << 24)
             | (uint32_t(uint8_t(msg[chunk + i * 4 + 1])) << 16)
             | (uint32_t(uint8_t(msg[chunk + i * 4 + 2])) << 8)
             | uint32_t(uint8_t(msg[chunk + i * 4 + 3]));
    }
    for (int i = 16; i < 80; ++i)
    {
      w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    uint32_t a = h0, b = h1, c = h2, d = h3, e = h4;
    for (int i = 0; i < 80; ++i)
    {
      uint32_t f, k;
      if (i < 20)
      {
        f = (b & c) | (~b & d);
        k = 0x5A827999;
      }
      else if (i < 40)
      {
        f = b ^ c ^ d;
        k = 0x6ED9EBA1;
      }
      else if (i < 60)
      {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8F1BBCDC;
      }
      else
      {
        f = b ^ c ^ d;
        k = 0xCA62C1D6;
      }
      const uint32_t tmp = rol(a, 5) + f + e + k + w[i];
      e = d;
      d = c;
      c = rol(b, 30);
      b = a;
      a = tmp;
    }
    h0 += a;
    h1 += b;
    h2 += c;
    h3 += d;
    h4 += e;
  }

  std::array<uint8_t, 20> out{};
  const uint32_t hs[5] = {h0, h1, h2, h3, h4};
  for (int i = 0; i < 5; ++i)
  {
    out[i * 4] = uint8_t(hs[i] >> 24);
    out[i * 4 + 1] = uint8_t(hs[i] >> 16);
    out[i * 4 + 2] = uint8_t(hs[i] >> 8);
    out[i * 4 + 3] = uint8_t(hs[i]);
  }
  return out;
}

inline std::string base64(const uint8_t* data, size_t len)
{
  static const char* tbl =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (size_t i = 0; i < len; i += 3)
  {
    uint32_t n = uint32_t(data[i]) << 16;
    if (i + 1 < len)
      n |= uint32_t(data[i + 1]) << 8;
    if (i + 2 < len)
      n |= data[i + 2];
    out.push_back(tbl[(n >> 18) & 63]);
    out.push_back(tbl[(n >> 12) & 63]);
    out.push_back(i + 1 < len ? tbl[(n >> 6) & 63] : '=');
    out.push_back(i + 2 < len ? tbl[n & 63] : '=');
  }
  return out;
}

inline std::string webSocketAccept(const std::string& key)
{
  const auto digest = sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
  return base64(digest.data(), digest.size());
}

} // namespace jamlink
