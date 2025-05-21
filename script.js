// script.js
const speakButton = document.getElementById('speakButton');
const statusDiv = document.getElementById('status');
const transcriptDiv = document.getElementById('transcript');
const responseDiv = document.getElementById('response');

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;

if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false; // Riconosce una singola frase
    recognition.lang = 'it-IT';
    recognition.interimResults = false; // Vogliamo solo i risultati finali

    recognition.onstart = () => {
        statusDiv.textContent = 'In ascolto...';
        speakButton.textContent = '🤫 Ascoltando...';
        speakButton.disabled = true;
    };

    recognition.onresult = async (event) => {
        const current = event.resultIndex;
        const transcript = event.results[current][0].transcript.trim();
        transcriptDiv.textContent = transcript;
        statusDiv.textContent = 'Elaborazione...';

        try {
            // 1. Invia trascrizione all'API chat
            const chatResponse = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: transcript })
            });

            if (!chatResponse.ok) {
                const errorData = await chatResponse.json();
                throw new Error(errorData.error || `Errore HTTP: ${chatResponse.status}`);
            }

            const chatData = await chatResponse.json();
            const assistantReply = chatData.reply;
            responseDiv.textContent = assistantReply; // Mostra la risposta testuale

            // 2. Invia la risposta testuale all'API TTS
            statusDiv.textContent = 'Sintesi vocale...';
            const ttsResponse = await fetch('/api/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: assistantReply })
            });

            if (!ttsResponse.ok) {
                // Se l'errore è JSON, prova a leggerlo, altrimenti testo semplice
                let errorText = `Errore HTTP TTS: ${ttsResponse.status}`;
                try {
                    const errorDataTTS = await ttsResponse.json();
                    errorText = errorDataTTS.error || errorText;
                } catch(e) {
                    errorText = await ttsResponse.text();
                }
                throw new Error(errorText);
            }

            const audioBlob = await ttsResponse.blob();
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            statusDiv.textContent = 'Riproduzione...';
            audio.play();
            audio.onended = () => {
                statusDiv.textContent = 'Pronta per un\'altra domanda.';
                speakButton.textContent = '🎙️ Parla di nuovo';
                speakButton.disabled = false;
                URL.revokeObjectURL(audioUrl); // Pulisci l'URL dell'oggetto
            };

        } catch (error) {
            console.error('Errore:', error);
            statusDiv.textContent = `Errore: ${error.message}`;
            responseDiv.textContent = '';
            speakButton.textContent = '🎙️ Riprova';
            speakButton.disabled = false;
        }
    };

    recognition.onerror = (event) => {
        console.error('Errore SpeechRecognition:', event.error);
        statusDiv.textContent = `Errore riconoscimento: ${event.error}. Riprova.`;
        speakButton.textContent = '🎙️ Parla';
        speakButton.disabled = false;
    };

    recognition.onend = () => {
        // Non reimpostare il pulsante qui se stiamo elaborando
        if (statusDiv.textContent === 'In ascolto...') { // Terminato senza input vocale valido
             statusDiv.textContent = 'Nessun input rilevato. Clicca per riprovare.';
             speakButton.textContent = '🎙️ Parla';
             speakButton.disabled = false;
        }
    };

} else {
    speakButton.disabled = true;
    statusDiv.textContent = "Il tuo browser non supporta l'API SpeechRecognition.";
    alert("Il tuo browser non supporta l'API SpeechRecognition. Prova con Chrome o Edge.");
}

speakButton.addEventListener('click', () => {
    if (recognition) {
        transcriptDiv.textContent = '';
        responseDiv.textContent = '';
        try {
            recognition.start();
        } catch (error) {
             // A volte, se si clicca troppo velocemente, può dare errore "already started"
            console.warn("Recognition start error, possibly already started:", error);
            statusDiv.textContent = 'Attendi un momento e riprova.';
             speakButton.textContent = '🎙️ Parla';
             speakButton.disabled = false; // Riabilita se c'è un errore all'avvio
        }
    }
});
