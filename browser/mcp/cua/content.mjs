// Content exports from a tab into local files: YouTube transcripts and Google Workspace documents.
// Both read through the page itself, so they use the user's signed-in session.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPORT_DIR = join(tmpdir(), "browser-control-exports");
const TRANSCRIPT_WAIT_MS = 8_000;

const GSUITE_FORMATS = {
  document: { pdf: "export?format=pdf", docx: "export?format=docx", md: "export?format=md", txt: "export?format=txt" },
  spreadsheets: { xlsx: "export?format=xlsx", csv: "export?format=csv", pdf: "export?format=pdf" },
  presentation: { pptx: "export/pptx", pdf: "export/pdf" },
};

function safeName(text) {
  return (text || "export").replace(/[^\p{L}\p{N} ._-]+/gu, "_").trim().slice(0, 80) || "export";
}

function save(name, data) {
  mkdirSync(EXPORT_DIR, { recursive: true });
  const path = join(EXPORT_DIR, name);
  writeFileSync(path, data);
  return path;
}

// Reads caption tracks from the player, falling back to the page's transcript panel.
const READ_TRANSCRIPT = `async (waitMs) => {
  const player = document.querySelector("#movie_player");
  const response = player?.getPlayerResponse?.() ?? window.ytInitialPlayerResponse;
  const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = tracks.find((t) => t.kind !== "asr") ?? tracks[0];
  if (track) {
    try {
      const json = await (await fetch(track.baseUrl + "&fmt=json3", { credentials: "include" })).json();
      const lines = (json.events ?? []).filter((e) => e.segs).map((e) => {
        const seconds = Math.floor((e.tStartMs ?? 0) / 1000);
        const stamp = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
        return stamp + " " + e.segs.map((s) => s.utf8).join("").replace(/\\n/g, " ").trim();
      }).filter((line) => line.split(" ").length > 1);
      if (lines.length) return lines.join("\\n");
    } catch {}
  }
  const segments = () => [...document.querySelectorAll("ytd-transcript-segment-renderer, transcript-segment-view-model")];
  if (!segments().length) {
    document.querySelector("#description-inline-expander #expand, tp-yt-paper-button#expand")?.click();
    await new Promise((r) => setTimeout(r, 400));
    const button =
      document.querySelector("ytd-video-description-transcript-section-renderer button") ??
      [...document.querySelectorAll("button")].find((b) => /transcript|transkrypcj/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));
    button?.click();
    const deadline = Date.now() + waitMs;
    while (!segments().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  }
  const lines = segments().map((segment) => {
    const stamp = segment.querySelector(".segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp")?.textContent.trim();
    const text = segment.querySelector(".segment-text, [role=text], .ytAttributedStringHost")?.textContent.trim();
    return stamp && text ? stamp + " " + text : segment.innerText.split("\\n").filter(Boolean).pop();
  }).filter(Boolean);
  if (!lines.length) throw new Error("This video has no transcript available");
  return lines.join("\\n");
}`;

export function createContentApi(tab) {
  return {
    async exportYouTubeTranscript() {
      const url = new URL(await tab.url());
      if (!/(^|\.)youtube\.com$/.test(url.hostname) || url.pathname !== "/watch") throw new Error("Open a youtube.com/watch page first");
      const text = await tab.evaluateInPage(`(${READ_TRANSCRIPT})(${TRANSCRIPT_WAIT_MS})`);
      const title = (await tab.title())?.replace(/^\(\d+\)\s*/, "").replace(/ - YouTube$/, "");
      return save(`${safeName(title)}-${url.searchParams.get("v")}.txt`, text);
    },

    async exportGsuite(type) {
      const url = new URL(await tab.url());
      const match = url.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([^/]+)/);
      if (url.hostname !== "docs.google.com" || !match) throw new Error("Open a Google Docs, Sheets or Slides document first");
      const [, kind, id] = match;
      const suffix = GSUITE_FORMATS[kind][type];
      if (!suffix) throw new Error(`Google ${kind} cannot be exported as ${type}; use one of ${Object.keys(GSUITE_FORMATS[kind]).join(", ")}`);
      const base64 = await tab.evaluateInPage(`(async () => {
        const response = await fetch(${JSON.stringify(`/${kind}/d/${id}/${suffix}`)}, { credentials: "include" });
        if (!response.ok) throw new Error("Export failed with HTTP " + response.status);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(binary);
      })()`);
      return save(`${safeName((await tab.title())?.replace(/ - Google (Docs|Sheets|Slides)$/, ""))}.${type}`, Buffer.from(base64, "base64"));
    },
  };
}
