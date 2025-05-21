const startButton = document.getElementById('startButton');
const statusDiv = document.getElementById('status');
const outputDiv = document.getElementById('output');
let recognition;

if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognitionAPI();
    recognition.lang = 'it-IT';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    startButton.onclick = () => {
        try {
            statusDiv.textContent = 'In ascolto... parla pure!';
            recognition.start();
            startButton.disabled = true;
            startButton.textContent = "Sto ascoltando...";
        } catch (error) {
            console.error("Errore all'avvio del riconoscimento:", error);
            statusDiv.textContent = 'Errore: non posso iniziare l\'ascolto ora. Riprova.';
            startButton.disabled = false;
            startButton.textContent = "🎤 Parla";
        }
    };

    recognition.onresult = async (event) => { // Aggiunto async qui
        const speechResult = event.results[0][0].transcript;
        addMessageToChat('Tu: ' + speechResult, 'user');
        statusDiv.textContent = 'Trascritto: "' + speechResult + '". Invio a OpenAI...';

        try {
            const response = await fetch('/api/chat', { // Chiama la nostra nuova API
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ userMessage: speechResult }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Errore dalla API');
            }

            const data = await response.json();
            const aiResponse = data.reply;

            addMessageToChat('AI: ' + aiResponse, 'assistant');
            statusDiv.textContent = 'Premi "Parla" per continuare.';
            // Prossimo passo: riprodurre aiResponse come audio
            // speak(aiResponse);

        } catch (error) {
            console.error('Errore nella chiamata API:', error);
            addMessageToChat('AI: Spiacente, c\'è stato un errore: ' + error.message, 'assistant');
            statusDiv.textContent = 'Errore. Premi "Parla" per riprovare.';
        }
    };

    recognition.onspeechend = () => {
        recognition.stop();
        statusDiv.textContent = 'Ascolto terminato. Elaborazione...';
        startButton.disabled = false;
        startButton.textContent = "🎤 Parla";
    };

    recognition.onnomatch = () => {
        statusDiv.textContent = "Non ho capito. Prova a parlare più chiaramente.";
        startButton.disabled = false;
        startButton.textContent = "🎤 Parla";
    };

    recognition.onerror = (event) => {
        statusDiv.textContent = 'Errore nel riconoscimento: ' + event.error;
        if (event.error === 'no-speech') {
            statusDiv.textContent = 'Non ho sentito nulla. Assicurati che il microfono sia attivo.';
        } else if (event.error === 'audio-capture') {
            statusDiv.textContent = 'Problema con il microfono. Controlla i permessi.';
        } else if (event.error === 'not-allowed') {
            statusDiv.textContent = 'Permesso di usare il microfono negato. Abilitalo nelle impostazioni del browser.';
        }
        startButton.disabled = false;
        startButton.textContent = "🎤 Parla";
    };

} else {
    startButton.disabled = true;
    statusDiv.textContent = "Il tuo browser non supporta il riconoscimento vocale.";
    alert("Il tuo browser non supporta l'API Web Speech. Prova con Chrome o Edge aggiornati.");
}

function addMessageToChat(message, sender) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', sender);
    messageElement.textContent = message;
    outputDiv.appendChild(messageElement);
    outputDiv.scrollTop = outputDiv.scrollHeight;
}

// Funzione per la sintesi vocale (la implementeremo dopo)
// async function speak(text) {
//     // ... codice per chiamare l'API TTS di OpenAI e riprodurre l'audio
// }
