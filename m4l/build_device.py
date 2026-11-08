#!/usr/bin/env python3
"""Generate the JamConnect Link Max for Live MIDI effect.

Writes:
  JamConnectLink.maxpat  - plain Max patcher (open in Max to inspect / edit)
  JamConnectLink.amxd    - Max for Live MIDI device (ampf container around the patcher)

The device expects jamconnect-m4l.js and jamconnect-live.js next to it. After
loading it in Live once, use "Freeze Device" to embed both scripts.
"""
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

boxes = []
lines = []


def box(bid, maxclass, text=None, rect=(0, 0, 100, 22), pres=None, inlets=1, outlets=1, **extra):
    b = {
        "id": bid,
        "maxclass": maxclass,
        "numinlets": inlets,
        "numoutlets": outlets,
        "patching_rect": list(rect),
    }
    if text is not None:
        b["text"] = text
    if outlets:
        b["outlettype"] = [""] * outlets
    if pres is not None:
        b["presentation"] = 1
        b["presentation_rect"] = list(pres)
    b.update(extra)
    boxes.append({"box": b})
    return bid


def wire(src, src_out, dst, dst_in=0):
    lines.append({"patchline": {"source": [src, src_out], "destination": [dst, dst_in]}})


# --- MIDI from the track: pass through + send to JamConnect
box("midiin", "newobj", "midiin", (30, 30, 50, 22), inlets=1, outlets=1)
box("midiout_thru", "newobj", "midiout", (30, 420, 55, 22), inlets=1, outlets=0)
box("midiparse", "newobj", "midiparse", (120, 70, 120, 22), inlets=1, outlets=8)
box("prep_note", "newobj", "prepend note", (120, 110, 85, 22))
box("prep_cc", "newobj", "prepend cc", (215, 110, 75, 22))
wire("midiin", 0, "midiout_thru")
wire("midiin", 0, "midiparse")
wire("midiparse", 0, "prep_note")
wire("midiparse", 2, "prep_cc")

# --- Node for Max client
box("node", "newobj", "node.script jamconnect-m4l.js @autostart 1 @watch 0",
    (120, 200, 320, 22), inlets=1, outlets=2)
wire("prep_note", 0, "node")
wire("prep_cc", 0, "node")

box("route", "newobj", "route note cc live status link peers", (120, 240, 300, 22), inlets=1, outlets=7)
wire("node", 0, "route")

# notes / cc from other jammers -> instrument on this track
box("slice_note", "newobj", "zl.slice 2", (120, 300, 65, 22), inlets=2, outlets=2)
box("slice_cc", "newobj", "zl.slice 2", (195, 300, 65, 22), inlets=2, outlets=2)
box("midiformat", "newobj", "midiformat", (120, 360, 140, 22), inlets=7, outlets=1)
box("midiout", "newobj", "midiout", (120, 420, 55, 22), inlets=1, outlets=0)
wire("route", 0, "slice_note")
wire("route", 1, "slice_cc")
wire("slice_note", 0, "midiformat", 0)
wire("slice_cc", 0, "midiformat", 2)
wire("midiformat", 0, "midiout")

# LIVE_* -> LiveAPI js -> replies back into node.script
box("prep_live", "newobj", "prepend live", (275, 300, 80, 22))
box("livejs", "newobj", "js jamconnect-live.js", (275, 340, 140, 22), inlets=1, outlets=1)
wire("route", 2, "prep_live")
wire("prep_live", 0, "livejs")
wire("livejs", 0, "node")

# --- presentation UI
box("title", "comment", "JAMCONNECT · LINK", (480, 20, 200, 20), pres=(8, 6, 200, 18),
    inlets=1, outlets=0, fontsize=12.0, fontface=1)
box("status_prep", "newobj", "prepend set", (330, 380, 75, 22))
box("status_msg", "message", "status: starting", (480, 60, 280, 22), pres=(8, 28, 280, 20), inlets=2, outlets=1)
wire("route", 3, "status_prep")
wire("status_prep", 0, "status_msg")

box("link_prep", "newobj", "prepend set tempo/playing/linkpeers", (420, 420, 210, 22))
box("link_msg", "message", "tempo/playing/linkpeers -", (480, 90, 280, 22), pres=(8, 52, 280, 20), inlets=2, outlets=1)
wire("route", 4, "link_prep")
wire("link_prep", 0, "link_msg")

box("peers_prep", "newobj", "prepend set jammers", (640, 420, 120, 22))
box("peers_msg", "message", "jammers 0", (480, 120, 140, 22), pres=(8, 76, 140, 20), inlets=2, outlets=1)
wire("route", 5, "peers_prep")
wire("peers_prep", 0, "peers_msg")

for bid, text, x, px in [
    ("btn_connect", "connect ws://127.0.0.1:20809", 480, 8),
    ("btn_disconnect", "disconnect", 700, 200),
]:
    box(bid, "message", text, (x, 160, 200 if bid == "btn_connect" else 80, 22),
        pres=(px, 104, 185 if bid == "btn_connect" else 80, 20), inlets=2, outlets=1)
    wire(bid, 0, "node")

for bid, text, px in [("btn_play", "play 1", 8), ("btn_stop", "play 0", 60)]:
    box(bid, "message", text, (480 + px * 2, 200, 50, 22), pres=(px, 130, 48, 20), inlets=2, outlets=1)
    wire(bid, 0, "node")

box("help", "comment", "Start jamlink-bridge first. Turn on Link + Start Stop Sync in Live.",
    (480, 240, 300, 20), pres=(115, 130, 180, 32), inlets=1, outlets=0, fontsize=9.0, linecount=2)

patcher = {
    "patcher": {
        "fileversion": 1,
        "appversion": {"major": 8, "minor": 6, "revision": 0, "architecture": "x64", "modernui": 1},
        "classnamespace": "box",
        "rect": [100.0, 100.0, 820.0, 500.0],
        "openinpresentation": 1,
        "default_fontsize": 10.0,
        "default_fontface": 0,
        "default_fontname": "Arial Bold",
        "gridonopen": 1,
        "gridsize": [8.0, 8.0],
        "devicewidth": 300.0,
        "description": "JamConnect Link: connect Ableton Live to JamConnect apps over Ableton Link",
        "boxes": boxes,
        "lines": lines,
        "dependency_cache": [
            {"name": "jamconnect-m4l.js", "bootpath": ".", "type": "TEXT", "implicit": 1},
            {"name": "jamconnect-live.js", "bootpath": ".", "type": "TEXT", "implicit": 1},
        ],
        "latency": 0,
        "is_mpe": 0,
        "autosave": 0,
    }
}


def write_amxd(path, patch):
    # Max for Live container: 'ampf' + device type ('mmmm' = MIDI effect),
    # an empty 'meta' chunk and the patcher JSON in a 'ptch' chunk.
    body = json.dumps(patch, indent=1).encode("utf-8") + b"\n\x00"
    with open(path, "wb") as f:
        f.write(b"ampf" + struct.pack("<I", 4) + b"mmmm")
        f.write(b"meta" + struct.pack("<I", 4) + b"\x00\x00\x00\x00")
        f.write(b"ptch" + struct.pack("<I", len(body)) + body)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else HERE
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "JamConnectLink.maxpat"), "w", encoding="utf-8") as f:
        json.dump(patcher, f, indent=1)
    write_amxd(os.path.join(out, "JamConnectLink.amxd"), patcher)
    print(f"wrote JamConnectLink.maxpat / .amxd to {out} ({len(boxes)} boxes, {len(lines)} lines)")


if __name__ == "__main__":
    main()
