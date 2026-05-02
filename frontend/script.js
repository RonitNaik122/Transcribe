console.log("MULTI-TAB TRANSCRIBE + AI NOTES v4 LOADED");

const CHUNK_DURATION = 30000;
let sessionCounter = 0;
const sessions = {};
const api = "https://transcribe-h8gf.onrender.com";

// -------------------- SESSION FACTORY --------------------
function createSession(id) {
  return {
    id,
    stream: null,
    isRecording: false,
    currentRecorder: null,
    fullTranscript: "",
    queue: [],
    isProcessing: false,
  };
}

// -------------------- EMPTY STATE --------------------
function updateEmptyState() {
  const empty = document.getElementById("empty-state");
  const container = document.getElementById("sessions-container");
  const hasSessions = container.children.length > 0;
  empty.style.display = hasSessions ? "none" : "flex";
}

// -------------------- SILENCE DETECTION --------------------
async function isSilent(blob) {
  try {
    const audioCtx = new AudioContext();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const data = audioBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    await audioCtx.close();
    return rms < 0.01;
  } catch {
    return false;
  }
}

// -------------------- QUEUE PROCESSING --------------------
async function processQueue(session) {
  if (session.isProcessing || !session.queue.length) return;
  session.isProcessing = true;
  const blob = session.queue.shift();

  try {
    const formData = new FormData();
    formData.append("file", blob, "recording.webm");
    const res = await fetch(api+"/upload", {
      method: "POST",
      body: formData,
    });
    const { text } = JSON.parse(await res.text());
    if (text?.trim()) appendText(session, text.trim());
  } catch (err) {
    console.error(`[Session ${session.id}] Chunk error:`, err);
  }

  session.isProcessing = false;
  processQueue(session);
}

// -------------------- RECORD CHUNK --------------------
function recordChunk(session) {
  if (!session.isRecording) return;

  const chunks = [];
  const audioStream = new MediaStream(
    session.stream.getAudioTracks().map((t) => t.clone()),
  );
  const recorder = new MediaRecorder(audioStream);
  session.currentRecorder = recorder;

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = async () => {
    audioStream.getTracks().forEach((t) => t.stop());
    if (session.isRecording) recordChunk(session);

    if (chunks.length) {
      const blob = new Blob(chunks, { type: "audio/webm" });
      if (blob.size > 3000) {
        const silent = await isSilent(blob);
        if (!silent) {
          session.queue.push(blob);
          processQueue(session);
        }
      }
    }
  };

  recorder.start();
  setTimeout(() => {
    if (recorder.state !== "inactive") recorder.stop();
  }, CHUNK_DURATION);
}

// -------------------- UI HELPERS --------------------
function setStatus(panel, state) {
  const pill = panel.querySelector(".status-pill");
  const text = panel.querySelector(".statusText");
  pill.className = "status-pill " + state;
  text.textContent = state;
}

function appendText(session, text) {
  const panel = document.getElementById("panel-" + session.id);
  const output = panel.querySelector(".output");
  const wordCount = panel.querySelector(".word-count");

  if (output.classList.contains("empty")) {
    output.classList.remove("empty");
    output.textContent = "";
  }

  const cursor = output.querySelector(".cursor");
  if (cursor) cursor.remove();

  session.fullTranscript += (session.fullTranscript ? " " : "") + text;
  output.textContent = session.fullTranscript;

  const cur = document.createElement("span");
  cur.className = "cursor";
  output.appendChild(cur);
  output.scrollTop = output.scrollHeight;

  const words = session.fullTranscript.trim()
    ? session.fullTranscript.trim().split(/\s+/).length
    : 0;

  wordCount.textContent = words + (words === 1 ? " word" : " words");

  panel.querySelector(".btn-download").disabled = false;
  panel.querySelector(".btn-generate").disabled = false;
}

function removeCursor(panel) {
  const cursor = panel.querySelector(".cursor");
  if (cursor) cursor.remove();
}

// -------------------- STOP SESSION --------------------
function stopSession(session) {
  session.isRecording = false;
  if (session.currentRecorder?.state !== "inactive")
    session.currentRecorder.stop();
  session.stream?.getTracks().forEach((t) => t.stop());

  const panel = document.getElementById("panel-" + session.id);
  setStatus(panel, "idle");
  panel.querySelector(".btn-start").disabled = false;
  panel.querySelector(".btn-stop").disabled = true;
  removeCursor(panel);

  if (session.fullTranscript.trim()) {
    panel.querySelector(".btn-download").disabled = false;
    panel.querySelector(".btn-generate").disabled = false;
  }
}

// -------------------- START SESSION --------------------
async function startSession(session) {
  session.fullTranscript = "";
  const panel = document.getElementById("panel-" + session.id);
  const output = panel.querySelector(".output");
  const wordCount = panel.querySelector(".word-count");

  output.textContent = "Waiting for audio...";
  output.classList.add("empty");
  removeCursor(panel);
  wordCount.textContent = "0 words";
  panel.querySelector(".btn-download").disabled = true;
  panel.querySelector(".btn-generate").disabled = true;

  try {
    session.stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        sampleRate: 44100,
      },
    });

    if (!session.stream.getAudioTracks().length) {
      output.classList.remove("empty");
      output.textContent = "No audio track. Tick 'Share tab audio'.";
      session.stream.getTracks().forEach((t) => t.stop());
      return;
    }

    session.isRecording = true;
    setStatus(panel, "recording");
    panel.querySelector(".btn-start").disabled = true;
    panel.querySelector(".btn-stop").disabled = false;

    recordChunk(session);
    session.stream.getVideoTracks()[0].onended = () => stopSession(session);
  } catch (err) {
    output.classList.remove("empty");
    output.textContent = "Error: " + err.message;
    setStatus(panel, "idle");
  }
}

// -------------------- DOWNLOAD TXT --------------------
function downloadTranscript(session) {
  if (!session.fullTranscript.trim()) return;
  const blob = new Blob([session.fullTranscript], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `transcript_session${session.id}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// -------------------- BUILD PANEL --------------------
// type: "live" | "yt"
function buildPanel(id, type = "live") {
  const panel = document.createElement("div");
  panel.className = "session-panel";
  panel.id = "panel-" + id;

  const typeBadgeClass = type === "yt" ? "yt" : "live";
  const typeBadgeLabel = type === "yt" ? "YouTube" : "Live";

  // For YT sessions, hide Start/Stop controls
  const liveControls =
    type === "live"
      ? `<button class="btn btn-start">Start</button>
         <button class="btn btn-stop" disabled>Stop</button>`
      : "";

  panel.innerHTML = `
    <div class="panel-header">
      <div class="panel-title">
        <span class="session-label">Session ${id}</span>
        <span class="session-type-badge ${typeBadgeClass}">${typeBadgeLabel}</span>
        ${
          type === "live"
            ? `<span class="status-pill idle"><span class="dot"></span><span class="statusText">idle</span></span>`
            : ""
        }
      </div>
      <div class="panel-actions">
        ${liveControls}
        <button class="btn btn-download" disabled>.txt</button>
        <button class="btn btn-generate" disabled>Generate Notes PDF</button>
      </div>
    </div>
    <div class="transcript-header">
      <span class="transcript-label">Transcript</span>
      <span class="word-count">0 words</span>
    </div>
    <div class="output empty">Waiting...</div>
  `;

  const session = createSession(id);
  sessions[id] = session;

  if (type === "live") {
    panel.querySelector(".btn-start").onclick = () => startSession(session);
    panel.querySelector(".btn-stop").onclick = () => stopSession(session);
  }

  panel.querySelector(".btn-download").onclick = () =>
    downloadTranscript(session);

  panel.querySelector(".btn-generate").onclick = async () => {
    const btn = panel.querySelector(".btn-generate");
    const originalText = btn.textContent;

    try {
      btn.disabled = true;
      btn.textContent = "Generating...";

      const response = await fetch(api+"/generate-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: session.fullTranscript }),
      });

      const data = await response.json();

      if (data.download_url) {
        // Trigger the download automatically
        window.open(data.download_url, "_blank");
      } else {
        alert("Failed to generate notes.");
      }
    } catch (err) {
      console.error(err);
      alert("Error connecting to AI backend.");
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  };

  return panel;
}

// -------------------- YOUTUBE FLOW --------------------
async function createYouTubeSession(url) {
  sessionCounter++;

  const panel = buildPanel(sessionCounter, "yt");
  document.getElementById("sessions-container").appendChild(panel);
  updateEmptyState();

  const session = sessions[sessionCounter];
  const output = panel.querySelector(".output");

  output.textContent = "Fetching YouTube transcript...";
  output.classList.remove("empty");

  try {
    const res = await fetch(`${api}/youtube?url=${encodeURIComponent(url)}`, {
      method: "POST",
    });

    const data = await res.json();

    if (data.text) {
      session.fullTranscript = data.text.trim();
      output.textContent = session.fullTranscript;

      const words = session.fullTranscript.split(/\s+/).length;
      panel.querySelector(".word-count").textContent =
        words + (words === 1 ? " word" : " words");

      panel.querySelector(".btn-download").disabled = false;
      panel.querySelector(".btn-generate").disabled = false;
    } else {
      output.textContent = "No transcript returned.";
      output.classList.add("empty");
    }
  } catch (err) {
    output.textContent = "Error: " + err.message;
    output.classList.add("empty");
  }
}

// -------------------- LIVE SESSION FLOW --------------------
function createLiveSession() {
  sessionCounter++;
  document
    .getElementById("sessions-container")
    .appendChild(buildPanel(sessionCounter, "live"));
  updateEmptyState();
}

// -------------------- MODAL HELPERS --------------------
function openModal(id) {
  document.getElementById(id).classList.add("open");
}

function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}

// -------------------- SOURCE PICKER MODAL --------------------
function triggerAddSession() {
  openModal("sourceModal");
}

document.getElementById("addSession").onclick = triggerAddSession;
document.getElementById("addSessionEmpty").onclick = triggerAddSession;

document.getElementById("modalCancel").onclick = () =>
  closeModal("sourceModal");

// Close modal on overlay click
document.getElementById("sourceModal").addEventListener("click", (e) => {
  if (e.target === document.getElementById("sourceModal"))
    closeModal("sourceModal");
});

// -------------------- YOUTUBE CHOICE --------------------
document.getElementById("ytOption").onclick = () => {
  closeModal("sourceModal");
  // Clear previous input and open YT URL modal
  document.getElementById("ytUrlInput").value = "";
  openModal("ytUrlModal");
  setTimeout(() => document.getElementById("ytUrlInput").focus(), 100);
};

// -------------------- YT URL MODAL --------------------
document.getElementById("ytUrlCancel").onclick = () => closeModal("ytUrlModal");

document.getElementById("ytUrlModal").addEventListener("click", (e) => {
  if (e.target === document.getElementById("ytUrlModal"))
    closeModal("ytUrlModal");
});

document.getElementById("ytUrlSubmit").onclick = () => {
  const url = document.getElementById("ytUrlInput").value.trim();
  if (!url) {
    document.getElementById("ytUrlInput").focus();
    return;
  }
  closeModal("ytUrlModal");
  createYouTubeSession(url);
};

// Also allow Enter key in URL field
document.getElementById("ytUrlInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("ytUrlSubmit").click();
});

// -------------------- LIVE / OTHER CHOICE --------------------
document.getElementById("otherOption").onclick = () => {
  closeModal("sourceModal");
  createLiveSession();
};

// -------------------- INIT --------------------
// Show empty state on load — no sessions created automatically
updateEmptyState();
