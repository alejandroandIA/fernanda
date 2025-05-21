// script.js
const speakButton = document.getElementById('speakButton');
const statusDiv = document.getElementById('status');
const transcriptDiv = document.getElementById('transcript');
const responseDiv = document.getElementById('response');
const audioPlayback = document.getElementById('audioPlayback'); // Se volessi usarlo, ma ne creiamo uno nuovo

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;
let currentAudio = null; // Per tenere traccia dell'audio corrente e poterlo fermare se serve

if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.lang = 'it-IT';
    recognition.interimResults = false;

    recognition.onstart = () => {
        statusDiv.textContent = 'In ascolto...';
        speakButton.textContent = '🤫 Ascoltando...';
        speakButton.disabled = true;
        transcriptDiv.textContent = '';
        responseDiv.textContent = '';
        if (currentAudio) {
            currentAudio.pause(); // Ferma audio precedente se l'utente clicca di nuovo
            currentAudio.src = ""; // Rilascia la risorsa
        }
    };

    recognition.onresult = async (event) => {
        const current = event.resultIndex;
        const transcript = event.results[current][0].transcript.trim();
        transcriptDiv.textContent = transcript;
        statusDiv.textContent = 'Elaborazione risposta...';
        speakButton.textContent = '⏳ Elaboro...';

        try {
            // 1. Invia trascrizione all'API chat
            const chatResponse = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: transcript })
            });

            if (!chatResponse.ok) {
                let errorMsg = `Errore Chat API: ${chatResponse.status}`;
                try { const errorData = await chatResponse.json(); errorMsg = errorData.error || errorMsg; } catch (e) {/* ignore */}
                throw new Error(errorMsg);
            }

            const chatData = await chatResponse.json();
            const assistantReply = chatData.reply;
            responseDiv.textContent = assistantReply;

            // 2. Invia la risposta testuale all'API TTS
            statusDiv.textContent = 'Sintesi vocale...';
            const ttsResponse = await fetch('/api/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: assistantReply })
            });

            if (!ttsResponse.ok) {
                let errorMsg = `Errore TTS API: ${ttsResponse.status}`;
                try { const errorData = await ttsResponse.json(); errorMsg = errorData.error || errorMsg; } catch (e) {/* ignore */}
                throw new Error(errorMsg);
            }

            const audioBlob = await ttsResponse.blob();
            const audioUrl = URL.createObjectURL(audioBlob);
            
            currentAudio = new Audio(); // Crea un nuovo oggetto Audio
            
            const playAudio = () => {
                currentAudio.src = audioUrl;
                statusDiv.textContent = 'Caricamento audio...';

                currentAudio.oncanplaythrough = () => {
                    statusDiv.textContent = 'Riproduzione...';
                    const playPromise = currentAudio.play();

                    if (playPromise !== undefined) {
                        playPromise.then(_ => {
                            // Riproduzione iniziata con successo
                        }).catch(error => {
                            console.error("Errore durante audio.play():", error);
                            statusDiv.textContent = `Audio bloccato dal browser.`;
                            responseDiv.innerHTML += `<br><small style="color:red;">L'audio è stato bloccato. Clicca di nuovo "Parla" o abilita l'audio per questo sito.</small>`;
                            // In uno scenario più complesso, potresti mostrare un pulsante di play manuale qui
                            resetSpeakButton();
                            URL.revokeObjectURL(audioUrl); // Pulisci se non può partire
                        });
                    }
                };

                currentAudio.onended = () => {
                    statusDiv.textContent = 'Pronta per un\'altra domanda.';
                    resetSpeakButton();
                    URL.revokeObjectURL(audioUrl);
                    currentAudio = null; // Pulisci riferimento
                };

                currentAudio.onerror = (e) => {
                    console.error("Errore oggetto Audio:", e);
                    statusDiv.textContent = 'Errore nel caricamento/riproduzione dell\'audio.';
                    resetSpeakButton();
                    URL.revokeObjectURL(audioUrl);
                    currentAudio = null; // Pulisci riferimento
                };
            };

            playAudio();

        } catch (error) {
            console.error('Errore nel flusso:', error);
            statusDiv.textContent = `Errore: ${error.message}`;
            responseDiv.textContent = '';
            resetSpeakButton();
            if (currentAudio) URL.revokeObjectURL(currentAudio.src); // Pulisci URL se esiste
            currentAudio = null;
        }
    };

    recognition.onerror = (event) => {
        console.error('Errore SpeechRecognition:', event.error);
        let errorMessage = `Errore riconoscimento: ${event.error}.`;
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            errorMessage += " Assicurati di aver concesso il permesso per il microfono al browser per questo sito.";
        } else if (event.error === 'no-speech') {
            errorMessage = "Nessun input vocale rilevato. Parla più forte o controlla il microfono.";
        }
        statusDiv.textContent = errorMessage;
        resetSpeakButton();
    };

    recognition.onend = () => {
        // Riabilita il pulsante solo se non siamo in una fase di elaborazione o riproduzione
        // Gli stati sono gestiti più finemente in onresult e onerror
        if (speakButton.textContent === '🤫 Ascoltando...') { // Terminato prematuramente o senza input
             statusDiv.textContent = 'Nessun input o riconoscimento interrotto. Clicca per riprovare.';
             resetSpeakButton();
        }
    };

} else {
    speakButton.disabled = true;
    statusDiv.textContent = "Il tuo browser non supporta l'API SpeechRecognition.";
    alert("Il tuo browser non supporta l'API SpeechRecognition. Prova con Chrome o Edge aggiornati.");
}

function resetSpeakButton() {
    speakButton.textContent = '🎙️ Parla di nuovo';
    speakButton.disabled = false;
}

speakButton.addEventListener('click', () => {
    if (recognition) {
        try {
            if (speakButton.textContent === '🤫 Ascoltando...' || speakButton.textContent === '⏳ Elaboro...') {
                console.log("Tentativo di interrompere riconoscimento/elaborazione in corso.");
                recognition.stop(); // Prova a fermare il riconoscimento se attivo
                if (currentAudio) {
                    currentAudio.pause();
                    currentAudio.src = "";
                    URL.revokeObjectURL(currentAudio.src); // Attenzione, potrebbe essere già revocato
                    currentAudio = null;
                }
                resetSpeakButton();
                statusDiv.textContent = "Operazione interrotta. Clicca per riprovare.";
                return;
            }
            recognition.start();
        } catch (error) {
            console.warn("Errore all'avvio del riconoscimento:", error);
            statusDiv.textContent = 'Attendi un momento e riprova a parlare.';
            resetSpeakButton();
        }
    }
});
