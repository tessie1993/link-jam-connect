#!/usr/bin/env python3
"""Generate the JamConnect Link Max for Live MIDI effect.

Writes:
  JamConnectLink.maxpat  - plain Max patcher (open in Max to inspect / edit)
  JamConnectLink.amxd    - Max for Live MIDI device (ampf container around the patcher)

Macro dials (m4l.macroCount, names/ranges from m4l.macros) are Live parameters; macro mappings
are kept in a hidden blob parameter saved with the Live set.

The device expects jamconnect-m4l.js and jamconnect-live.js next to it. After
loading it in Live once, use "Freeze Device" to embed both scripts.
"""
import json
import os
import shutil
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_NAME = "jamconnect.config.json"


def load_config(path=None):
    path = path or os.path.join(HERE, "..", CONFIG_NAME)
    with open(path, encoding="utf-8") as f:
        return json.load(f), os.path.abspath(path)


def bridge_url(cfg):
    m4l = cfg.get("m4l", {})
    if m4l.get("bridgeUrl"):
        return m4l["bridgeUrl"]
    bridge = cfg["bridge"]
    host = "127.0.0.1" if bridge["bind"] in ("0.0.0.0", "::") else bridge["bind"]
    return "ws://%s:%d" % (host, bridge["port"])


CONFIG, CONFIG_PATH = load_config(os.environ.get("JAMCONNECT_CONFIG"))

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

box("route", "newobj", "route note cc live status link peers url", (120, 240, 340, 22), inlets=1, outlets=8)
wire("node", 0, "route")

# notes / cc from other jammers (MIDI_EVENT, M4L_NOTE, M4L_CC) -> instrument on this track
box("slice_note", "newobj", "zl.slice 2", (120, 300, 65, 22), inlets=2, outlets=2)
box("slice_cc", "newobj", "zl.slice 2", (195, 300, 65, 22), inlets=2, outlets=2)
box("midiformat", "newobj", "midiformat", (120, 360, 140, 22), inlets=7, outlets=1)
box("midiout", "newobj", "midiout", (120, 420, 55, 22), inlets=1, outlets=0)
wire("route", 0, "slice_note")
wire("route", 1, "slice_cc")
wire("slice_note", 0, "midiformat", 0)
wire("slice_cc", 0, "midiformat", 2)
wire("midiformat", 0, "midiout")

# LIVE_* / M4L_* -> LiveAPI js -> replies back into node.script
box("prep_live", "newobj", "prepend live", (275, 300, 80, 22))
box("livejs", "newobj", "js jamconnect-live.js", (275, 340, 140, 22), inlets=1, outlets=3)
wire("route", 2, "prep_live")
wire("prep_live", 0, "livejs")
wire("livejs", 0, "node")

# The LiveAPI is usable once [live.thisdevice] bangs.
box("thisdevice", "newobj", "live.thisdevice", (430, 300, 90, 22), inlets=1, outlets=3)
box("msg_ready", "message", "deviceready", (430, 330, 75, 22), inlets=2, outlets=1)
wire("thisdevice", 0, "msg_ready")
wire("msg_ready", 0, "livejs")

# Macro mappings are stored with the Live set: a hidden "blob" parameter (pattr with
# parameter mode, type 3) keeps the URI-encoded JSON; it is restored when the set loads.
box("pattr_map", "newobj", "pattr jc_mappings @parameter_enable 1", (430, 380, 220, 22), inlets=2, outlets=3,
    parameter_enable=1, varname="jc_mappings",
    saved_attribute_attributes={"valueof": {
        "parameter_longname": "jc_mappings", "parameter_shortname": "jc_mappings",
        "parameter_type": 3, "parameter_invisible": 1}})
box("prep_restore", "newobj", "prepend restoremappings", (430, 410, 150, 22))
wire("livejs", 1, "pattr_map")
wire("pattr_map", 0, "prep_restore")
wire("prep_restore", 0, "livejs")

# --- presentation UI
box("title", "comment", "JAMCONNECT · LINK", (480, 20, 200, 20), pres=(8, 6, 200, 18),
    inlets=1, outlets=0, fontsize=12.0, fontface=1)
box("status_prep", "newobj", "prepend set", (330, 460, 75, 22))
box("status_msg", "message", "status: starting", (480, 60, 280, 22), pres=(8, 26, 280, 18), inlets=2, outlets=1)
wire("route", 3, "status_prep")
wire("status_prep", 0, "status_msg")

box("url_prep", "newobj", "prepend set", (330, 490, 75, 22))
box("url_msg", "message", bridge_url(CONFIG), (480, 90, 280, 22), pres=(8, 46, 280, 18), inlets=2, outlets=1)
wire("route", 6, "url_prep")
wire("url_prep", 0, "url_msg")

box("link_prep", "newobj", "prepend set tempo/playing/linkpeers", (420, 520, 210, 22))
box("link_msg", "message", "tempo/playing/linkpeers -", (480, 120, 280, 22), pres=(8, 66, 280, 18), inlets=2, outlets=1)
wire("route", 4, "link_prep")
wire("link_prep", 0, "link_msg")

box("peers_prep", "newobj", "prepend set jammers", (640, 520, 120, 22))
box("peers_msg", "message", "jammers 0", (480, 150, 140, 22), pres=(8, 86, 135, 18), inlets=2, outlets=1)
wire("route", 5, "peers_prep")
wire("peers_prep", 0, "peers_msg")

# Buttons: "connect" without arguments reconnects to the configured / last URL.
for bid, text, px, w in [("btn_connect", "connect", 8, 64), ("btn_disconnect", "disconnect", 76, 70),
                         ("btn_play", "play 1", 150, 48), ("btn_stop", "play 0", 202, 48)]:
    box(bid, "message", text, (480 + px * 2, 190, w, 22), pres=(px, 108, w, 20), inlets=2, outlets=1)
    wire(bid, 0, "node")

box("help", "comment", "Start jamlink-bridge first. Turn on Link + Start Stop Sync in Live.",
    (480, 230, 300, 20), pres=(8, 132, 280, 18), inlets=1, outlets=0, fontsize=9.0)

# --- macro dials: real Live parameters (m4l.macroCount, names / ranges from m4l.macros)
M4L = CONFIG["m4l"]
MACRO_COUNT = int(M4L["macroCount"])
MACROS = M4L["macros"]
if len(MACROS) < MACRO_COUNT:
    raise SystemExit("config: m4l.macros has fewer entries than m4l.macroCount")
DIAL_W, DIAL_H, DIAL_X0 = 44, 48, 296
if MACRO_COUNT:
    box("route_macro", "newobj", "route " + " ".join(str(i) for i in range(MACRO_COUNT)),
        (275, 600, 40 + 22 * MACRO_COUNT, 22), inlets=2, outlets=MACRO_COUNT + 1)
    wire("livejs", 2, "route_macro")
for i in range(MACRO_COUNT):
    m = MACROS[i]
    col, row = i % ((MACRO_COUNT + 1) // 2), i // ((MACRO_COUNT + 1) // 2)
    dial = "macro%d" % i
    box(dial, "live.dial", None, (275 + 60 * i, 650, 44, 48),
        pres=(DIAL_X0 + col * DIAL_W, 6 + row * (DIAL_H + 22), DIAL_W, DIAL_H), inlets=1, outlets=2,
        parameter_enable=1, varname="macro%d" % (i + 1),
        saved_attribute_attributes={"valueof": {
            "parameter_longname": m["name"], "parameter_shortname": m.get("shortName", m["name"]),
            "parameter_type": 0, "parameter_mmin": m["min"], "parameter_mmax": m["max"],
            "parameter_initial_enable": 1, "parameter_initial": [m.get("initial", m["min"])],
            "parameter_unitstyle": 1}})
    box("prep_macro%d" % i, "newobj", "prepend macro %d" % i, (275 + 60 * i, 710, 58, 22))
    wire("route_macro", i, dial)
    wire(dial, 0, "prep_macro%d" % i)
    wire("prep_macro%d" % i, 0, "livejs")

DEVICE_WIDTH = DIAL_X0 + DIAL_W * max(1, (MACRO_COUNT + 1) // 2) + 8

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
        "devicewidth": float(DEVICE_WIDTH),
        "description": "JamConnect Link: connect Ableton Live to JamConnect apps over Ableton Link",
        "boxes": boxes,
        "lines": lines,
        "dependency_cache": [
            {"name": "jamconnect-m4l.js", "bootpath": ".", "type": "TEXT", "implicit": 1},
            {"name": "jamconnect-live.js", "bootpath": ".", "type": "TEXT", "implicit": 1},
            {"name": CONFIG_NAME, "bootpath": ".", "type": "JSON", "implicit": 1},
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
    # The node script reads the config from its own folder (also embedded when frozen).
    if os.path.abspath(out) != os.path.dirname(CONFIG_PATH):
        shutil.copyfile(CONFIG_PATH, os.path.join(out, CONFIG_NAME))
    print(f"wrote JamConnectLink.maxpat / .amxd to {out} ({len(boxes)} boxes, {len(lines)} lines)")


if __name__ == "__main__":
    main()
