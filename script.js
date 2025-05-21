// script.js
const controlButton = document.getElementById('controlButton');
const statusMessage = document.getElementById('statusMessage');

// --- VAD (Voice Activity Detection) Variables ---
let audioContext;
let analyser;
let microphoneSource;
// ScriptProcessorNode è deprecato ma più semplice per un esempio. Per produzione, AudioWorklet è meglio.
// let scriptProcessor;
const VAD_SILENCE_THRESHOLD = 0.01; // Da tarare: sensibilità al volume (0-1)
const VAD_SILENCE_DURATION_MS = 1800; // Millisecondi di silenzio prima di considerare l'utente aver finito
const VAD_SPEECH_MIN_DURATION_MS = 300; // Minima durata del parlato per inviare
let silenceStartTime = 0;
let speaking = false;
let speechStartTime = 0;
let globalStream = null;
let vadProcessTimeout = null; // Per gestire il loop di requestAnimationFrame

// Array per i chunk audio del turno corrente dell'utente e MediaRecorder
let currentTurnAudioChunks = [];
let mediaRecorderForVAD;
let recordingMimeType = '';
let recordingFilenameForVAD = 'user_vad_audio.webm'; // Default, verrà aggiornato

// --- Cronologia Conversazione ---
let conversationHistory = [];

// --- Stati UI e Gestione Audio Fernanda ---
let currentAudio = null; // Per l'audio di Fernanda
let isFernandaSpeaking = false;
let currentConversationState = 'idle'; // idle, listening_continuous, processing_vad_chunk, fernanda_speaking_continuous

function updateUI(state, buttonText, buttonIconClass, statusText) {
    currentConversationState = state;
    controlButton.innerHTML = `<span class="${buttonIconClass}"></span>${buttonText}`;
    statusMessage.textContent = statusText || '';

    // Il pulsante è disabilitato solo durante l'elaborazione effettiva
    controlButton.disabled = (state === 'processing_vad_chunk');

    if (state === 'fernanda_speaking_continuous') {
        // Permetti di interrompere Fernanda
        controlButton.innerHTML = `<span class="icon-stop"></span>Interrompi Fernanda`;
        controlButton.disabled = false; // Abilita per interrompere
    }
    console.log("UI Update:", state, buttonText, statusText);
}

async function initializeAudioProcessing() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
        controlButton.disabled = true;
        return false;
    }

    try {
        globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512; // Più piccolo per reattività, ma meno preciso per frequenze basse
        analyser.minDecibels = -70;
        analyser.maxDecibels = -10;
        analyser.smoothingTimeConstant = 0.6; // Meno smussamento per reattività

        microphoneSource = audioContext.createMediaStreamSource(globalStream);
        microphoneSource.connect(analyser);

        // Scegli il MIME type preferito per MediaRecorder
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
            recordingMimeType = 'audio/webm;codecs=opus';
            recordingFilenameForVAD = 'user_vad_audio.webm';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) { // Spesso M4A
            recordingMimeType = 'audio/mp4';
            recordingFilenameForVAD = 'user_vad_audio.mp4';
        } else if (MediaRecorder.isTypeSupported('audio/wav')) {
            recordingMimeType = 'audio/wav';
            recordingFilenameForVAD = 'user_vad_audio.wav';
        } else {
            recordingMimeType = ''; // Lascia che il browser scelga
            recordingFilenameForVAD = 'user_vad_audio.dat'; // Fallback generico
            console.warn("Nessun formato MIME preferito (webm, mp4, wav) supportato per VAD. Usando default browser.");
        }
        console.log("VAD Recording: MIME Type =", recordingMimeType || "Browser Default", "| Filename =", recordingFilenameForVAD);
        return true;
    } catch (err) {
        console.error('Errore getUserMedia o AudioContext:', err);
        let msg = 'Errore microfono.';
        if (err.name === 'NotAllowedError') msg = 'Permesso microfono negato.';
        if (err.name === 'NotFoundError') msg = 'Nessun microfono trovato.';
        updateUI('idle', 'Errore Mic.', 'icon-mic', msg);
        controlButton.disabled = true;
        return false;
    }
}

function startVAD() {
    if (!audioContext || !analyser || !globalStream) {
        console.error("AudioContext non inizializzato per VAD.");
        stopVAD(); // Prova a pulire se qualcosa è andato storto
        updateUI('idle', 'Errore Avvio', 'icon-mic', 'Errore avvio VAD. Ricarica.');
        return;
    }
    updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop-session', 'Ascolto...');
    speaking = false;
    silenceStartTime = performance.now();
    currentTurnAudioChunks = [];

    const options = recordingMimeType ? { mimeType: recordingMimeType } : {};
    try {
        mediaRecorderForVAD = new MediaRecorder(globalStream, options);
    } catch (e) {
        console.error("Errore creazione MediaRecorder:", e, "Opzioni:", options);
        stopVAD();
        updateUI('idle', 'Errore Registratore', 'icon-mic', 'Formato audio non supportato dal browser.');
        return;
    }

    mediaRecorderForVAD.ondataavailable = event => {
        if (event.data.size > 0) {
            currentTurnAudioChunks.push(event.data);
        }
    };
    mediaRecorderForVAD.onstart = () => {
        console.log("MediaRecorder for VAD started.");
    };
    mediaRecorderForVAD.onstop = () => {
        console.log("MediaRecorder for VAD stopped. Chunks:", currentTurnAudioChunks.length);
    };
    mediaRecorderForVAD.onerror = (event) => {
        console.error("MediaRecorder error:", event.error);
        // Potrebbe essere utile fermare il VAD e segnalare l'errore all'utente
        stopVAD();
        updateUI('idle', 'Errore Registrazione', 'icon-mic', 'Problema con la registrazione audio.');
    };
    mediaRecorderForVAD.start(500); // Raccogli chunk frequentemente (es. ogni 500ms)

    processAudioLoop();
}

function stopVAD() {
    console.log("Tentativo di fermare VAD...");
    if (vadProcessTimeout) {
        cancelAnimationFrame(vadProcessTimeout);
        vadProcessTimeout = null;
    }

    if (mediaRecorderForVAD && mediaRecorderForVAD.state === "recording") {
        mediaRecorderForVAD.stop();
    }
    mediaRecorderForVAD = null; // Rilascia riferimento

    if (microphoneSource) {
        microphoneSource.disconnect();
        microphoneSource = null;
    }
    // Non chiudere audioContext qui, potrebbe servire per riavviare
    // if (audioContext && audioContext.state !== 'closed') {
    //     audioContext.close().catch(console.error);
    //     audioContext = null;
    // }
    // Non fermare globalStream qui, potrebbe servire per riavviare
    // if (globalStream) {
    //     globalStream.getTracks().forEach(track => track.stop());
    //     globalStream = null;
    // }

    currentTurnAudioChunks = [];
    speaking = false;
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
    console.log("VAD fermato.");
}

function cleanUpFullSession() {
    console.log("Pulizia completa della sessione VAD.");
    stopVAD(); // Ferma il loop VAD e MediaRecorder

    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(e => console.warn("Errore chiusura AudioContext:", e));
        audioContext = null;
    }
    if (globalStream) {
        globalStream.getTracks().forEach(track => track.stop());
        globalStream = null;
    }
    conversationHistory = []; // Resetta la cronologia
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
}


function processAudioLoop() {
    if (currentConversationState !== 'listening_continuous') {
        console.log("processAudioLoop: non in ascolto, esco.");
        return;
    }

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(dataArray);

    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
        sum += ((dataArray[i] / 128.0) - 1.0) ** 2;
    }
    const rms = Math.sqrt(sum / dataArray.length);
    const currentTime = performance.now();

    if (rms > VAD_SILENCE_THRESHOLD) {
        if (!speaking) {
            speaking = true;
            speechStartTime = currentTime;
            console.log("VAD: Inizio parlato (RMS:", rms.toFixed(3), ")");
        }
        silenceStartTime = currentTime;
    } else { // Silenzio
        if (speaking) { // Era in "parlato" e ora c'è silenzio
            if (currentTime - silenceStartTime > VAD_SILENCE_DURATION_MS) {
                console.log("VAD: Fine parlato (RMS:", rms.toFixed(3), ", Silenzio per", (currentTime - silenceStartTime).toFixed(0), "ms)");
                speaking = false;
                const speechDuration = currentTime - speechStartTime - VAD_SILENCE_DURATION_MS;

                if (speechDuration > VAD_SPEECH_MIN_DURATION_MS && currentTurnAudioChunks.length > 0) {
                    console.log("VAD: Invio audio. Durata:", speechDuration.toFixed(0), "ms. Chunks:", currentTurnAudioChunks.length);
                    
                    // Copia i chunk da inviare e pulisci l'array per il prossimo turno
                    const chunksToSend = [...currentTurnAudioChunks];
                    currentTurnAudioChunks = []; // Svuota subito per il prossimo turno

                    // Determina il MIME type effettivo dai chunk, se disponibile
                    const actualMimeType = chunksToSend.length > 0 && chunksToSend[0].type ? 
                                           chunksToSend[0].type : 
                                           (recordingMimeType || 'application/octet-stream');
                    const audioBlob = new Blob(chunksToSend, { type: actualMimeType });
                    
                    sendAudioForTranscription(audioBlob, recordingFilenameForVAD);
                    return; // Esci dal loop, verrà ripreso dopo la risposta di Fernanda o errore
                } else {
                    console.log("VAD: Parlato troppo breve o nessun chunk. Durata:", speechDuration.toFixed(0), "ms. Chunks:", currentTurnAudioChunks.length);
                    currentTurnAudioChunks = []; // Pulisci comunque
                }
            }
        } else {
            silenceStartTime = currentTime; // Continua ad aggiornare l'inizio del silenzio
        }
    }
    vadProcessTimeout = requestAnimationFrame(processAudioLoop);
}

async function sendAudioForTranscription(audioBlob, filename) {
    if (audioBlob.size === 0) {
        console.warn("Blob audio vuoto, non invio.");
        resumeListeningAfterFernanda(); // Torna ad ascoltare
        return;
    }

    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Trascrivo...');
    const formData = new FormData();
    formData.append('audio', audioBlob, filename);

    try {
        const transcribeResponse = await fetch('/api/transcribe', {
            method: 'POST',
            body: formData
        });

        if (!transcribeResponse.ok) {
            const errData = await transcribeResponse.json().catch(() => ({ error: "Errore API Trascrizione (no JSON)" }));
            throw new Error(errData.error || `Trascrizione Fallita: ${transcribeResponse.status}`);
        }
        const { transcript } = await transcribeResponse.json();
        console.log("Whisper transcript (VAD):", transcript);

        if (!transcript || transcript.trim().length < 2) {
            statusMessage.textContent = 'Non ho capito. Ripeti pure.';
            setTimeout(resumeListeningAfterFernanda, 1000); // Breve pausa prima di riascoltare
            return;
        }
        
        // Aggiungi trascrizione utente alla cronologia
        conversationHistory.push({ role: 'user', content: transcript });
        await processChatWithFernanda(transcript);

    } catch (error) {
        console.error('Errore trascrizione (VAD):', error.message);
        statusMessage.textContent = `Errore: ${error.message}. Riprova parlando.`;
        setTimeout(resumeListeningAfterFernanda, 1500); // Pausa prima di riascoltare
    }
}

async function processChatWithFernanda(transcript) {
    // Lo stato UI dovrebbe essere già 'processing_vad_chunk' o simile
    statusMessage.textContent = 'Fernanda pensa...';

    try {
        const chatResponse = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: transcript, history: conversationHistory }) // INVIA CRONOLOGIA
        });

        if (!chatResponse.ok) {
            const errData = await chatResponse.json().catch(() => ({ error: "Errore API Chat (no JSON)" }));
            throw new Error(errData.error || `Errore Chat API: ${chatResponse.status}`);
        }
        const chatData = await chatResponse.json();
        const assistantReply = chatData.reply;
        console.log("Fernanda's text reply (VAD):", assistantReply);

        // Aggiungi risposta assistente alla cronologia
        conversationHistory.push({ role: 'assistant', content: assistantReply });
        // Tronca la cronologia se diventa troppo lunga (es. ultimi 10 messaggi utente/assistente = 20 elementi)
        const MAX_HISTORY_LENGTH = 20; 
        if (conversationHistory.length > MAX_HISTORY_LENGTH) {
            conversationHistory = conversationHistory.slice(conversationHistory.length - MAX_HISTORY_LENGTH);
        }

        const ttsResponse = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: assistantReply })
        });

        if (!ttsResponse.ok) {
            const errData = await ttsResponse.json().catch(() => ({ error: "Errore API TTS (no JSON)" }));
            throw new Error(errData.error || `Errore TTS API: ${ttsResponse.status}`);
        }
        const audioFernandaBlob = await ttsResponse.blob();
        const audioUrl = URL.createObjectURL(audioFernandaBlob);
        playFernandaAudio(audioUrl);

    } catch (error) {
        console.error('Errore nel flusso chat/tts (VAD):', error);
        statusMessage.textContent = `Oops: ${error.message}. Riprova parlando.`;
        setTimeout(resumeListeningAfterFernanda, 1500);
    }
}

function playFernandaAudio(audioUrl) {
    if (currentAudio) {
        currentAudio.pause();
        if (currentAudio.src) URL.revokeObjectURL(currentAudio.src);
    }
    currentAudio = new Audio(audioUrl);
    isFernandaSpeaking = true;
    updateUI('fernanda_speaking_continuous', 'Interrompi Fernanda', 'icon-stop', 'Fernanda parla...');

    currentAudio.onended = () => {
        console.log("Fernanda finished speaking (VAD).");
        isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        if (currentConversationState === 'fernanda_speaking_continuous') { // Solo se non interrotta o terminata
            resumeListeningAfterFernanda();
        }
    };
    currentAudio.onerror = (e) => {
        console.error("Errore audio playback (VAD):", e);
        isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        if (currentConversationState === 'fernanda_speaking_continuous') {
            statusMessage.textContent = 'Problema audio. Riprova parlando.';
            setTimeout(resumeListeningAfterFernanda, 1000);
        }
    };

    currentAudio.play().catch(error => {
        console.error("Autoplay bloccato o errore play (VAD):", error);
        if (isFernandaSpeaking) {
            isFernandaSpeaking = false;
            statusMessage.textContent = 'Audio bloccato. Riprova parlando.';
            setTimeout(resumeListeningAfterFernanda, 1000);
        }
        if (currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
    });
}

function resumeListeningAfterFernanda() {
    // Solo se la sessione non è stata terminata dall'utente nel frattempo
    if (currentConversationState === 'idle' || currentConversationState === 'listening_continuous' || currentConversationState === 'fernanda_speaking_continuous') {
        updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop-session', 'Tocca a te...');
        if (mediaRecorderForVAD && mediaRecorderForVAD.state === "inactive") {
            currentTurnAudioChunks = []; // Assicurati che i chunk siano puliti
            mediaRecorderForVAD.start(500);
        }
        vadProcessTimeout = requestAnimationFrame(processAudioLoop);
    }
}

async function handleControlButtonClick() {
    if (currentConversationState === 'idle') {
        const ready = await initializeAudioProcessing();
        if (ready) {
            startVAD();
        }
    } else if (currentConversationState === 'listening_continuous' || currentConversationState === 'processing_vad_chunk') {
        cleanUpFullSession(); // Termina e pulisci tutto
    } else if (currentConversationState === 'fernanda_speaking_continuous') {
        // Interrompi Fernanda e torna ad ascoltare
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0; // Resetta audio
            if (currentAudio.src) URL.revokeObjectURL(currentAudio.src); // Libera risorsa
            currentAudio = null;
        }
        isFernandaSpeaking = false;
        resumeListeningAfterFernanda();
    }
}

controlButton.addEventListener('click', handleControlButtonClick);

// Stato iniziale UI
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
    controlButton.disabled = true;
} else {
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
}
