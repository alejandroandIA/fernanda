// script.js
const controlButton = document.getElementById('controlButton');
const statusMessage = document.getElementById('statusMessage');

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;
let currentAudio = null;
let isFernandaSpeaking = false;
let currentConversationState = 'idle'; // Stati: idle, listeningToUser, processing, fernandaSpeaking

// Helper per aggiornare il pulsante e lo stato
function updateUI(state, buttonText, buttonIcon, statusText) {
    currentConversationState = state;
    controlButton.innerHTML = `<span class="${buttonIcon}"></span>${buttonText}`;
    statusMessage.textContent = statusText || '';
    controlButton.disabled = (state === 'processing'); // Disabilita solo durante l'elaborazione API
    console.log("UI Update:", state, buttonText, statusText);
}

if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.lang = 'it-IT';
    recognition.interimResults = false;

    recognition.onstart = () => {
        updateUI('listeningToUser', 'Parla Ora...', 'icon-listening', 'Ti ascolto...');
    };

    recognition.onresult = async (event) => {
        const transcript = event.results[event.resultIndex][0].transcript.trim();
        console.log("User said:", transcript);
        if (!transcript) {
            console.log("No speech detected or empty transcript.");
            updateUI('idle', 'Riprova', 'icon-mic', 'Non ho sentito bene. Riprova.');
            return;
        }

        updateUI('processing', 'Elaboro...', 'icon-thinking', 'Sto pensando...');

        try {
            const chatResponse = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: transcript })
            });

            if (!chatResponse.ok) {
                const errData = await chatResponse.json().catch(() => ({error: "Errore API Chat sconosciuto"}));
                throw new Error(errData.error || `Errore Chat API: ${chatResponse.status}`);
            }
            const chatData = await chatResponse.json();
            const assistantReply = chatData.reply;
            console.log("Fernanda's text reply:", assistantReply);

            const ttsResponse = await fetch('/api/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: assistantReply })
            });

            if (!ttsResponse.ok) {
                const errData = await ttsResponse.json().catch(() => ({error: "Errore API TTS sconosciuto"}));
                throw new Error(errData.error || `Errore TTS API: ${ttsResponse.status}`);
            }

            const audioBlob = await ttsResponse.blob();
            const audioUrl = URL.createObjectURL(audioBlob);
            
            playFernandaAudio(audioUrl);

        } catch (error) {
            console.error('Errore nel flusso:', error);
            updateUI('idle', 'Errore', 'icon-mic', `Oops: ${error.message}. Riprova.`);
        }
    };

    recognition.onerror = (event) => {
        console.error('Errore SpeechRecognition:', event.error);
        let msg = 'Errore microfono.';
        if (event.error === 'no-speech') msg = 'Non ho sentito nulla. Parla più forte.';
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') msg = 'Permesso microfono negato.';
        updateUI('idle', 'Riprova', 'icon-mic', msg);
    };

    recognition.onend = () => {
        // Se recognition finisce e non siamo in processing o Fernanda non sta parlando, torna a idle
        if (currentConversationState === 'listeningToUser') {
            console.log("Recognition ended, no result or stopped listening.");
            // Potrebbe essere stato interrotto o semplicemente non ha catturato nulla.
            // Se onresult non viene chiamato, l'UI rimane in "Parla Ora...", quindi qui potremmo resettare
            // ma è meglio gestire il reset in onresult se non c'è trascrizione o in onerror.
        }
    };

} else {
    updateUI('idle', 'Non Supportato', 'icon-mic', 'Browser non supportato.');
    controlButton.disabled = true;
}

function playFernandaAudio(audioUrl) {
    if (currentAudio) {
        currentAudio.pause();
        if(currentAudio.src) URL.revokeObjectURL(currentAudio.src);
    }
    currentAudio = new Audio(audioUrl);
    isFernandaSpeaking = true;
    updateUI('fernandaSpeaking', 'Interrompi', 'icon-stop', 'Fernanda parla...');

    currentAudio.onended = () => {
        console.log("Fernanda finished speaking.");
        isFernandaSpeaking = false;
        if(currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src); // Pulisci URL dopo la fine
        currentAudio = null;
        // Solo se l'utente non ha già interrotto e iniziato a parlare di nuovo
        if (currentConversationState === 'fernandaSpeaking') { 
            updateUI('idle', 'Parla Ancora', 'icon-mic', 'Tocca a te.');
        }
    };

    currentAudio.onerror = (e) => {
        console.error("Errore audio playback:", e);
        isFernandaSpeaking = false;
        if(currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        updateUI('idle', 'Errore Audio', 'icon-mic', 'Problema con la riproduzione audio.');
    };

    // Tentativo di riproduzione
    const playPromise = currentAudio.play();
    if (playPromise !== undefined) {
        playPromise.catch(error => {
            console.error("Autoplay bloccato o errore play:", error);
            isFernandaSpeaking = false;
            // Se l'autoplay è bloccato, informiamo l'utente.
            // Per ora, torniamo a idle, ma idealmente avremmo un pulsante "Play" manuale per l'audio di Fernanda.
            // Questa parte andrà rivista per la robustezza su mobile.
            updateUI('idle', 'Audio Bloccato', 'icon-mic', 'Audio bloccato. Abilita autoplay o clicca per riprovare.');
            if(currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        });
    }
}

controlButton.addEventListener('click', () => {
    if (!SpeechRecognition) return;

    console.log("Button clicked. Current state:", currentConversationState);

    if (currentConversationState === 'idle' || currentConversationState === 'error') {
        try {
            recognition.start();
        } catch (e) {
            console.error("Errore avvio recognition:", e);
            updateUI('idle', 'Riprova', 'icon-mic', 'Errore avvio microfono.');
        }
    } else if (currentConversationState === 'listeningToUser') {
        // Utente clicca mentre sta parlando -> ferma l'ascolto e processa (o considera "fatto")
        recognition.stop(); 
        // onresult dovrebbe poi essere chiamato se c'è qualcosa, altrimenti onend
        // L'UI si aggiornerà di conseguenza
        updateUI('processing', 'Elaboro...', 'icon-thinking', 'Ok, ci penso...');
    } else if (currentConversationState === 'fernandaSpeaking') {
        // Utente interrompe Fernanda
        if (currentAudio) {
            currentAudio.pause();
            isFernandaSpeaking = false;
            if(currentAudio.src) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null; // Rilascia audio corrente
        }
        // E inizia subito ad ascoltare l'utente
        try {
            recognition.start(); // L'UI si aggiornerà in recognition.onstart
        } catch (e) {
            console.error("Errore avvio recognition dopo interruzione:", e);
            updateUI('idle', 'Riprova', 'icon-mic', 'Errore avvio microfono.');
        }
    } else if (currentConversationState === 'processing') {
        // Non fare nulla se cliccato mentre è in processing, il pulsante è già disabilitato.
        // O, se non fosse disabilitato, si potrebbe implementare una logica di "cancella richiesta".
    }
});

// Inizializza UI
updateUI('idle', 'Inizia', 'icon-mic', 'Pronta quando vuoi.');
