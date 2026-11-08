/* RIFF/WAVE decoding for wavetable import (PCM 8/16/24/32-bit, IEEE float 32/64, any channel count,
 * mixed to mono). Frame slicing, FFT and mip levels happen in the Rust engine (synth_load_table).
 * Serum-style files carry their frame size in a "clm " chunk ("<!>2048 ..."), returned as clmFrameSize. */
export function parseWav(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (dv.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let fmt = null, data = null, clmFrameSize = null;
  for (let o = 12; o + 8 <= dv.byteLength;) {
    const id = tag(o), len = dv.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') {
      fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
      if (fmt.format === 0xfffe && len >= 26) fmt.format = dv.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = { offset: body, length: Math.min(len, dv.byteLength - body) };
    } else if (id === 'clm ') {
      let s = '';
      for (let i = 0; i < Math.min(len, 32) && body + i < dv.byteLength; i++) s += String.fromCharCode(dv.getUint8(body + i));
      const m = /<!>\s*(\d+)/.exec(s);
      if (m) clmFrameSize = Number(m[1]);
    }
    o = body + len + (len & 1);
  }
  if (!fmt || !data) throw new Error('WAV without fmt/data chunk');
  if (fmt.format !== 1 && fmt.format !== 3) throw new Error(`unsupported WAV format ${fmt.format}`);
  const bps = fmt.bits / 8;
  const frameBytes = bps * fmt.channels;
  if (!(frameBytes > 0)) throw new Error('invalid WAV header');
  const n = Math.floor(data.length / frameBytes);
  const read = (o) => {
    if (fmt.format === 3) return fmt.bits === 64 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
    switch (fmt.bits) {
      case 8: return (dv.getUint8(o) - 128) / 128;
      case 16: return dv.getInt16(o, true) / 32768;
      case 24: return (dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16)) / 8388608;
      case 32: return dv.getInt32(o, true) / 2147483648;
      default: throw new Error(`unsupported WAV bit depth ${fmt.bits}`);
    }
  };
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += read(data.offset + i * frameBytes + c * bps);
    out[i] = s / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, samples: out, clmFrameSize };
}

/** Minimal 32-bit float mono WAV writer (tests / exporting a table). */
export function writeWavFloat(samples, sampleRate, clmFrameSize = null) {
  const clm = clmFrameSize ? `<!>${clmFrameSize} 00000000` : '';
  const clmLen = clm ? clm.length + (clm.length & 1) : 0;
  const dataLen = samples.length * 4;
  const size = 12 + 24 + (clm ? 8 + clmLen : 0) + 8 + dataLen;
  const dv = new DataView(new ArrayBuffer(size));
  let o = 0;
  const str = (s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o++, s.charCodeAt(i)); };
  str('RIFF'); dv.setUint32(o, size - 8, true); o += 4; str('WAVE');
  str('fmt '); dv.setUint32(o, 16, true); o += 4;
  dv.setUint16(o, 3, true); dv.setUint16(o + 2, 1, true); dv.setUint32(o + 4, sampleRate, true);
  dv.setUint32(o + 8, sampleRate * 4, true); dv.setUint16(o + 12, 4, true); dv.setUint16(o + 14, 32, true); o += 16;
  if (clm) { str('clm '); dv.setUint32(o, clm.length, true); o += 4; str(clm); if (clm.length & 1) o++; }
  str('data'); dv.setUint32(o, dataLen, true); o += 4;
  for (let i = 0; i < samples.length; i++, o += 4) dv.setFloat32(o, samples[i], true);
  return dv.buffer;
}
