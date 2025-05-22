// script.js
const controlButton = document.getElementById('controlButton');
const statusMessage = document.getElementById('statusMessage');

let audioContext; // Sarà il nostro AudioContext globale
let analyser;
let microphoneSource;
const VAD_SILENCE_THRESHOLD = 0.01;
const VAD_SILENCE_DURATION_MS = 1800;
const VAD_SPEECH_MIN_DURATION_MS = 300;
let silenceStartTime = 0;
let speaking = false;
let speechStartTime = 0;
let globalStream = null;
let vadProcessTimeout = null;

let currentTurnAudioChunks = [];
let mediaRecorderForVAD;
let recordingMimeType = '';
const baseRecordingFilename = 'user_vad_audio';

let conversationHistory = [];

// --- Modifiche per Web Audio API Playback ---
let currentFernandaAudioSource = null; // Ora sarà un AudioBufferSourceNode
let fernandaAudioBuffer = null;       // L'AudioBuffer decodificato
// -----------------------------------------
let isFernandaSpeaking = false;
let currentConversationState = 'idle';
let audioContextUnlocked = false;
let fernandaAudioBlobUrl = null; // Manteniamo l'URL del blob per il fetch

function updateUI(state, buttonText, buttonIconClass, statusText) {
    currentConversationState = state;
    controlButton.innerHTML = `<span class="${buttonIconClass}"></span>${buttonText}`;
    statusMessage.textContent = statusText || '';
    controlButton.disabled = (state === 'initializing' || state === 'processing_vad_chunk');

    if (state === 'fernanda_speaking_continuous') {
        controlButton.innerHTML = `<span class="icon-stop"></span>Interrompi Fernanda`;
    }
    // Lo stato 'awaiting_play_permission' potrebbe non essere più necessario se Web Audio API funziona bene
    // ma lo lasciamo per ora come possibile fallback mentale, anche se l'obiettivo è evitarlo.
    console.log("UI Update:", state, buttonText, statusText);
}

function getExtensionFromMimeType(mimeType) {
    if (!mimeType) return '.bin';
    const typeSpecific = mimeType.split(';')[0].toLowerCase();
    switch (typeSpecific) {
        case 'audio/webm': return '.webm';
        case 'audio/opus': return '.opus';
        case 'audio/ogg': return '.ogg';
        case 'audio/mp4': return '.mp4';
        case 'audio/m4a': return '.m4a';
        case 'audio/aac': return '.aac';
        case 'audio/wav': case 'audio/wave': return '.wav';
        case 'audio/mpeg': return '.mp3';
        default: console.warn(`Estensione MIME non nota: ${mimeType}`); return '.bin';
    }
}

async function unlockAudioContextIfNeeded() {
    if (!audioContext) {
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            console.log("AudioContext creato. Stato iniziale:", audioContext.state, "Sample Rate:", audioContext.sampleRate);
        } catch (e) {
            console.error("Errore creazione AudioContext:", e);
            updateUI('idle', 'Errore Audio Init', 'icon-mic', 'Audio non inizializzabile.');
            controlButton.disabled = true;
            return false;
        }
    }

    if (audioContext.state === 'suspended') {
        console.log('AudioContext sospeso, tentativo di resume...');
        try {
            await audioContext.resume();
            if (audioContext.state === 'running') {
                console.log('AudioContext resumed successfully to RUNNING state.');
                audioContextUnlocked = true;
                return true;
            } else {
                console.warn('AudioContext.resume() non ha portato a "running". Stato:', audioContext.state);
                // Tentativo di fallback con suono silenzioso se resume() non è bastato
                // Questo è più un hack per vecchi browser o casi ostinati
                const buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
                const source = audioContext.createBufferSource();
                source.buffer = buffer;
                source.connect(audioContext.destination);
                source.start(0);
                await new Promise(resolve => setTimeout(resolve, 50)); // Breve attesa
                if (audioContext.state === 'running') {
                    console.log('AudioContext running after silent sound workaround.');
                    audioContextUnlocked = true;
                    return true;
                } else {
                     console.warn('AudioContext ancora NON running dopo workaround. Stato:', audioContext.state);
                     return false;
                }
            }
        } catch (e) {
            console.error('Errore durante AudioContext.resume():', e);
            return false;
        }
    } else if (audioContext.state === 'running') {
        console.log('AudioContext è già running.');
        audioContextUnlocked = true;
        return true;
    }
    console.warn('Stato AudioContext inatteso o non gestito:', audioContext.state);
    return false;
}

async function initializeAudioProcessing() {
    updateUI('initializing', 'Avvio...', 'icon-mic', 'Inizializzazione audio...');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
        controlButton.disabled = true; return false;
    }

    // Lo sblocco dell'AudioContext è ora gestito principalmente da handleControlButtonClick
    // o da unlockAudioContextIfNeeded quando serve.
    // Qui ci assicuriamo che esista se stiamo per usarlo.
    if (!audioContext) {
        await unlockAudioContextIfNeeded(); // Tenta di crearlo e sbloccarlo
    }
    if (!audioContext || audioContext.state !== 'running') {
        console.warn("initializeAudioProcessing: AudioContext non è 'running'. L'analisi VAD potrebbe avere problemi.");
        // Non blocchiamo qui, MediaRecorder potrebbe funzionare per la registrazione.
    }

    try {
        globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Se AudioContext esiste, connetti l'analyser
        if (audioContext) {
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            microphoneSource = audioContext.createMediaStreamSource(globalStream);
            microphoneSource.connect(analyser);
        } else {
            console.warn("AudioContext non disponibile per l'analyser VAD. Il VAD potrebbe non funzionare come previsto.");
        }


        const mimeTypesToTry = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/m4a', 'audio/ogg;codecs=opus', 'audio/wav'];
        let preferredMimeType = '';
        for (const mime of mimeTypesToTry) {
            if (MediaRecorder.isTypeSupported(mime)) {
                preferredMimeType = mime; break;
            }
        }
        recordingMimeType = preferredMimeType;
        console.log(`VAD Init: Richiesta MIME Type: ${recordingMimeType || "Browser Default"}`);
        return true;
    } catch (err) {
        console.error('Errore getUserMedia o setup:', err);
        let msg = 'Errore microfono.';
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') msg = 'Permesso microfono negato.';
        updateUI('idle', 'Errore Mic.', 'icon-mic', msg);
        return false;
    }
}

// ... (stopAndReleaseMediaRecorder, startVAD, proceedWithVadStart, cleanUpFullSession, processAudioLoop, sendAudioForTranscription, processChatWithFernanda rimangono sostanzialmente invariati rispetto all'ultima versione "funzionante" che avevi, assicurati di usare quelle.)
// Per brevità, non li incollo di nuovo qui, ma devono essere presenti e corretti.
// La modifica chiave è in playFernandaAudio e nelle funzioni che la toccano.

function stopAndReleaseMediaRecorder() {
    if (mediaRecorderForVAD) {
        if (mediaRecorderForVAD.state === "recording") {
            try { mediaRecorderForVAD.stop(); } catch (e) { console.warn("Errore stop MediaRecorder:", e); }
        }
        mediaRecorderForVAD.ondataavailable = null;
        mediaRecorderForVAD.onstart = null;
        mediaRecorderForVAD.onstop = null;
        mediaRecorderForVAD.onerror = null;
        mediaRecorderForVAD = null;
    }
}

function startVAD() {
    if (!audioContext || !analyser || !globalStream || !microphoneSource) { // L'analyser è necessario per il VAD
        console.error("Dipendenze VAD mancanti (AudioContext, Analyser, Stream, Source).");
        cleanUpFullSession();
        return;
    }
    if (audioContext.state === 'suspended') {
        console.warn("startVAD: AudioContext sospeso, tentativo di ripresa per Analyser.");
        audioContext.resume().then(() => proceedWithVadStart()).catch(() => proceedWithVadStart());
    } else {
        proceedWithVadStart();
    }
}

function proceedWithVadStart() {
    stopAndReleaseMediaRecorder();
    updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop', 'Ascolto...');
    speaking = false;
    silenceStartTime = performance.now();
    currentTurnAudioChunks = [];

    const options = recordingMimeType ? { mimeType: recordingMimeType } : {};
    try {
        mediaRecorderForVAD = new MediaRecorder(globalStream, options);
        if (mediaRecorderForVAD.mimeType) {
            if (recordingMimeType && mediaRecorderForVAD.mimeType !== recordingMimeType) {
                console.warn(`MediaRecorder userà: "${mediaRecorderForVAD.mimeType}" invece di "${recordingMimeType}".`);
            }
            recordingMimeType = mediaRecorderForVAD.mimeType;
        } else if (recordingMimeType) {
            console.warn(`MediaRecorder non ha un mimeType effettivo, si assume: "${recordingMimeType}".`);
        } else {
            recordingMimeType = 'application/octet-stream';
        }
        console.log("MediaRecorder creato. MIME type effettivo: ", recordingMimeType);

    } catch (e) {
        console.error("Errore creazione MediaRecorder:", e); cleanUpFullSession(); return;
    }

    mediaRecorderForVAD.ondataavailable = event => { if (event.data.size > 0) currentTurnAudioChunks.push(event.data); };
    mediaRecorderForVAD.onerror = (event) => { console.error("MediaRecorder error:", event.error); updateUI('idle', 'Errore Reg.', 'icon-mic', 'Errore reg.'); stopAndReleaseMediaRecorder(); };
    mediaRecorderForVAD.onstop = () => { console.log("MediaRecorder.onstop."); };
    try { mediaRecorderForVAD.start(500); } catch (e) { console.error("Errore mediaRecorder.start():", e); cleanUpFullSession(); return; }
    if (vadProcessTimeout) cancelAnimationFrame(vadProcessTimeout);
    processAudioLoop();
}

function cleanUpFullSession(resetAudioCtx = false) {
    if (vadProcessTimeout) cancelAnimationFrame(vadProcessTimeout); vadProcessTimeout = null;
    stopAndReleaseMediaRecorder();
    if (microphoneSource) microphoneSource.disconnect(); microphoneSource = null;
    analyser = null;

    if (resetAudioCtx && audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(e => console.warn("Errore chiusura AudioContext:", e));
        audioContext = null; audioContextUnlocked = false;
    }
    if (globalStream) globalStream.getTracks().forEach(track => track.stop()); globalStream = null;
    conversationHistory = []; currentTurnAudioChunks = []; speaking = false;

    // Pulizia per Web Audio API playback
    if (currentFernandaAudioSource) {
        try { currentFernandaAudioSource.stop(); } catch(e) {/*ignora se già fermato*/}
        currentFernandaAudioSource.disconnect();
        currentFernandaAudioSource = null;
    }
    fernandaAudioBuffer = null;
    if (fernandaAudioBlobUrl) URL.revokeObjectURL(fernandaAudioBlobUrl);
    fernandaAudioBlobUrl = null;
    isFernandaSpeaking = false;

    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
}

function processAudioLoop() {
    if (currentConversationState !== 'listening_continuous' || !analyser || !mediaRecorderForVAD) return;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(dataArray);
    let sum = 0; for (let i = 0; i < dataArray.length; i++) sum += ((dataArray[i] / 128.0) - 1.0) ** 2;
    const rms = Math.sqrt(sum / dataArray.length);
    const currentTime = performance.now();

    if (rms > VAD_SILENCE_THRESHOLD) {
        if (!speaking) { speaking = true; speechStartTime = currentTime; }
        silenceStartTime = currentTime;
    } else {
        if (speaking && (currentTime - silenceStartTime > VAD_SILENCE_DURATION_MS)) {
            speaking = false;
            const speechDuration = currentTime - speechStartTime - VAD_SILENCE_DURATION_MS;
            if (speechDuration > VAD_SPEECH_MIN_DURATION_MS && currentTurnAudioChunks.length > 0) {
                const chunks = [...currentTurnAudioChunks]; currentTurnAudioChunks = [];
                const blobMime = recordingMimeType || 'application/octet-stream';
                const audioBlob = new Blob(chunks, { type: blobMime });
                const ext = getExtensionFromMimeType(blobMime);
                const filename = `${baseRecordingFilename}${ext}`;
                console.log(`Invio VAD: ${filename}, Type: ${blobMime}, Size: ${audioBlob.size}`);
                sendAudioForTranscription(audioBlob, filename); return;
            } else { currentTurnAudioChunks = []; }
        } else if (!speaking) { silenceStartTime = currentTime; }
    }
    vadProcessTimeout = requestAnimationFrame(processAudioLoop);
}

async function sendAudioForTranscription(audioBlob, filename) {
    if (audioBlob.size === 0) { resumeListeningAfterFernanda(); return; }
    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Trascrivo...');
    const formData = new FormData(); formData.append('audio', audioBlob, filename);
    try {
        const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
        if (!res.ok) { const d = await res.json().catch(()=>({e:`Trascrizione Errore: ${res.status}`})); throw new Error(d.error || `Errore ${res.status}`);}
        const { transcript } = await res.json();
        if (!transcript || transcript.trim().length < 2) { statusMessage.textContent = 'Non ho capito.'; setTimeout(resumeListeningAfterFernanda, 1000); return; }
        conversationHistory.push({ role: 'user', content: transcript });
        await processChatWithFernanda(transcript);
    } catch (err) { console.error('Trascrizione errore:', err); statusMessage.textContent = `Errore: ${err.message}.`; setTimeout(resumeListeningAfterFernanda, 1500); }
}

async function processChatWithFernanda(transcript) {
    statusMessage.textContent = 'Fernanda pensa...';
    try {
        const res = await fetch('/api/chat', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({prompt:transcript, history:conversationHistory}) });
        if (!res.ok) { const d = await res.json().catch(()=>({e:`Chat Errore: ${res.status}`})); throw new Error(d.error || `Errore ${res.status}`);}
        const { reply } = await res.json();
        conversationHistory.push({ role: 'assistant', content: reply });
        if (conversationHistory.length > 20) conversationHistory.splice(0, conversationHistory.length - 20);

        const ttsRes = await fetch('/api/tts', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({text:reply}) });
        if (!ttsRes.ok) { const d = await ttsRes.json().catch(()=>({e:`TTS Errore: ${ttsRes.status}`})); throw new Error(d.error || `Errore ${ttsRes.status}`);}
        const audioFernandaBlob = await ttsRes.blob();
        if (fernandaAudioBlobUrl) URL.revokeObjectURL(fernandaAudioBlobUrl); // Pulisci vecchio URL
        fernandaAudioBlobUrl = URL.createObjectURL(audioFernandaBlob); // Nuovo URL per il fetch
        await playFernandaAudio(); // Usa il nuovo URL
    } catch (err) { console.error('Chat/TTS errore:', err); statusMessage.textContent = `Oops: ${err.message}.`; setTimeout(resumeListeningAfterFernanda, 1500); }
}


// --- NUOVA VERSIONE di playFernandaAudio con Web Audio API ---
async function playFernandaAudio() {
    if (!fernandaAudioBlobUrl) {
        console.warn("Nessun URL audio di Fernanda (Blob URL) da riprodurre.");
        resumeListeningAfterFernanda();
        return;
    }

    // Assicurati che l'AudioContext sia esistente e 'running'
    // Questo è FONDAMENTALE per Web Audio API
    if (!audioContext || audioContext.state !== 'running') {
        console.warn(`playFernandaAudio: AudioContext non pronto (stato: ${audioContext ? audioContext.state : 'nullo'}). Tentativo di sblocco.`);
        const unlocked = await unlockAudioContextIfNeeded();
        if (!unlocked || !audioContext || audioContext.state !== 'running') {
            console.error("playFernandaAudio: AudioContext non ha potuto essere sbloccato o non è 'running'. Impossibile riprodurre con Web Audio API.");
            statusMessage.textContent = "Errore audio: contesto non attivo. Prova a ricaricare o interagire.";
            // Qui potremmo implementare un fallback all'elemento <audio> con richiesta di tocco
            // Ma l'obiettivo è farlo funzionare con Web Audio API.
            resumeListeningAfterFernanda(); // Torna ad ascoltare, ma la riproduzione è fallita.
            return;
        }
        console.log("AudioContext sbloccato con successo prima della riproduzione.");
    }

    // Ferma e pulisci la sorgente precedente se esiste
    if (currentFernandaAudioSource) {
        try {
            currentFernandaAudioSource.stop();
            console.log("Sorgente audio precedente fermata.");
        } catch (e) { /* ignora se già fermata o non avviata */ }
        currentFernandaAudioSource.disconnect();
        currentFernandaAudioSource = null;
    }
    fernandaAudioBuffer = null; // Resetta il buffer precedente

    updateUI('fernanda_speaking_continuous', 'Interrompi Fernanda', 'icon-stop', 'Fernanda parla...');
    isFernandaSpeaking = true;

    try {
        console.log("Fetching audio blob per Web Audio API da:", fernandaAudioBlobUrl);
        const response = await fetch(fernandaAudioBlobUrl);
        if (!response.ok) {
            throw new Error(`Errore fetch blob audio: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        console.log("Audio blob fetched, dimensione ArrayBuffer:", arrayBuffer.byteLength);

        console.log("Tentativo decodeAudioData...");
        // Usa una Promise per decodeAudioData per una migliore gestione async/await
        fernandaAudioBuffer = await new Promise((resolve, reject) => {
            audioContext.decodeAudioData(arrayBuffer, resolve, reject);
        });
        console.log("Audio decodificato con successo. Durata:", fernandaAudioBuffer.duration, "s");

        currentFernandaAudioSource = audioContext.createBufferSource();
        currentFernandaAudioSource.buffer = fernandaAudioBuffer;
        currentFernandaAudioSource.connect(audioContext.destination);
        
        currentFernandaAudioSource.onended = () => {
            console.log("Web Audio: Fernanda finished speaking (onended event).");
            // Non revocare fernandaAudioBlobUrl qui, potrebbe servire se interrotta e ripresa
            // La pulizia del blob URL avverrà quando ne viene creato uno nuovo o in cleanUpFullSession
            if (isFernandaSpeaking) { // Solo se non è stata interrotta manualmente prima di finire
                isFernandaSpeaking = false;
                // currentFernandaAudioSource è già null o sarà reso null
                if (currentConversationState === 'fernanda_speaking_continuous') {
                    resumeListeningAfterFernanda();
                }
            }
            // Pulisci il riferimento al nodo sorgente, non può essere riutilizzato
            if (currentFernandaAudioSource) {
                currentFernandaAudioSource.disconnect(); // Assicura la disconnessione
                currentFernandaAudioSource = null;
            }
        };
        
        currentFernandaAudioSource.start(0); // Avvia la riproduzione
        console.log("Web Audio: currentFernandaAudioSource.start(0) chiamato.");

    } catch (error) {
        console.error("Errore durante riproduzione con Web Audio API:", error);
        isFernandaSpeaking = false;
        updateUI(currentConversationState, controlButton.textContent, controlButton.querySelector('span').className, `Errore audio Fernanda: ${error.message}`);
        
        if (currentFernandaAudioSource) {
            currentFernandaAudioSource.disconnect();
            currentFernandaAudioSource = null;
        }
        fernandaAudioBuffer = null;
        // Non revocare l'URL qui, potrebbe essere un problema temporaneo e vogliamo riprovare
        // o l'utente potrebbe volerlo. Ma per ora, semplicemente fallisce.
        
        // Se l'errore è NotAllowedError o simile (anche se meno probabile con Web Audio API una volta sbloccato),
        // potremmo implementare un fallback a un pulsante.
        // Per ora, assumiamo che se Web Audio fallisce dopo lo sblocco, è un errore più serio.
        statusMessage.textContent = "Impossibile riprodurre audio di Fernanda.";
        setTimeout(resumeListeningAfterFernanda, 1500);
    }
}
// --- FINE NUOVA VERSIONE di playFernandaAudio ---


function resumeListeningAfterFernanda() {
    console.log("resumeListeningAfterFernanda. Stato:", currentConversationState, "Stream:", !!globalStream);
    if (currentConversationState === 'idle' || !globalStream) {
        if (currentConversationState !== 'idle') cleanUpFullSession();
        return;
    }
    // Non riprendere VAD se l'UI è in attesa di un play manuale (anche se ora puntiamo a non usarlo)
    // if (currentConversationState === 'awaiting_play_permission') return;

    // isFernandaSpeaking dovrebbe essere già false qui se l'audio è finito o è stato interrotto
    console.log("Ripresa ascolto VAD dopo Fernanda.");
    setTimeout(() => {
        if (globalStream && audioContext && analyser && microphoneSource && audioContext.state === 'running') {
            startVAD();
        } else {
            console.warn("Condizioni non soddisfatte per riprendere VAD. Stream:", !!globalStream, "AC State:", audioContext ? audioContext.state : "null");
            cleanUpFullSession(); // Pulisci se non possiamo riprendere
        }
    }, 100);
}

async function handleControlButtonClick() {
    // Assicurati che l'AudioContext sia creato e tenta di sbloccarlo al primo click significativo
    const unlocked = await unlockAudioContextIfNeeded();
    if (!unlocked && currentConversationState === 'idle') {
        // Se è il primo click per avviare e non si sblocca, informa l'utente.
        // Questo è critico per Safari.
        // Potrebbe essere necessario un feedback UI più forte qui se lo sblocco fallisce.
        console.warn("handleControlButtonClick: AudioContext non sbloccato al click iniziale. L'audio potrebbe non funzionare.");
        // Non bloccare, ma l'esperienza potrebbe essere compromessa.
        if (!audioContext || audioContext.state !== 'running') {
             statusMessage.textContent = "Audio non attivato. Tocca di nuovo o controlla i permessi del browser.";
             // Forse non procedere se l'audio è essenziale e non sbloccato.
             // return; // SCOMMENTA QUESTO SE VUOI BLOCCARE L'AVVIO SENZA AUDIO CONTEXT RUNNING
        }
    }

    switch (currentConversationState) {
        case 'idle':
            if (!audioContext || audioContext.state !== 'running') {
                // Se, nonostante il tentativo di sblocco, non è 'running',
                // si potrebbe mostrare un messaggio più persistente o impedire l'avvio.
                console.error("Tentativo di avviare conversazione ma AudioContext non è 'running'.");
                statusMessage.textContent = "Audio non pronto. Riprova a toccare o ricarica.";
                return; // Impedisci l'avvio se l'audio non è pronto
            }
            const ready = await initializeAudioProcessing();
            if (ready) startVAD();
            else updateUI('idle', 'Errore Init', 'icon-mic', 'Inizializzazione fallita.');
            break;
        case 'listening_continuous':
        case 'processing_vad_chunk':
            cleanUpFullSession();
            break;
        case 'fernanda_speaking_continuous':
            if (currentFernandaAudioSource) {
                try { currentFernandaAudioSource.stop(); console.log("Interrotta riproduzione Fernanda."); } catch(e) {}
                // L'evento onended della sorgente gestirà la pulizia e resumeListening
            }
            isFernandaSpeaking = false; // Forza lo stato
            // L'onended dovrebbe chiamare resumeListeningAfterFernanda
            // Se non lo fa (es. interruzione prima di onended), chiamalo esplicitamente.
            // È meglio se onended lo gestisce per coerenza.
            // Per sicurezza, se non siamo sicuri che onended scatti subito:
            resumeListeningAfterFernanda();
            break;
        // Lo stato 'awaiting_play_permission' è meno probabile ora, ma lo lasciamo per completezza
        // case 'awaiting_play_permission':
        // if (fernandaAudioBlobUrl) await playFernandaAudio();
        // else resumeListeningAfterFernanda();
        // break;
        default: cleanUpFullSession();
    }
}

controlButton.addEventListener('click', handleControlButtonClick);

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
    controlButton.disabled = true;
} else {
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
}
