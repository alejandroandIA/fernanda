// api/chat.js
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY_FERNANDA,
});

// Funzione helper per troncare la cronologia se necessario (opzionale, ma buona pratica)
const MAX_HISTORY_TOKENS = 3000; // Esempio, gpt-4o ha un contesto ampio, ma è bene limitare
function countTokens(text) {
  // Stima molto approssimativa: 1 token ~ 4 caratteri in inglese, o 0.75 parole.
  // Per l'italiano potrebbe essere leggermente diverso.
  // Per un conteggio preciso, dovresti usare una libreria di tokenizzazione (es. tiktoken).
  return Math.ceil((text || '').length / 3); // Stima grossolana
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { prompt, history } = req.body; // Accetta 'history' dal corpo della richiesta

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  if (!process.env.OPENAI_API_KEY_FERNANDA) {
    console.error('OPENAI_API_KEY_FERNANDA not configured');
    return res.status(500).json({ error: 'Server configuration error: OpenAI API key missing.' });
  }

  try {
    const systemMessage = {
      role: "system",
      content: "Sei Fernanda, un'assistente vocale AI amichevole, utile e concisa. Rispondi in italiano, in modo naturale come se stessi parlando. Mantieni il contesto della conversazione precedente per dare risposte coerenti."
    };

    let messages = [systemMessage];

    // Gestisci la cronologia
    if (Array.isArray(history)) {
      let currentTokenCount = countTokens(systemMessage.content);
      const reversedHistory = [...history].reverse(); // Partiamo dai più recenti

      for (const message of reversedHistory) {
        const messageTokenCount = countTokens(message.content);
        if (currentTokenCount + messageTokenCount < MAX_HISTORY_TOKENS - countTokens(prompt) - 200 /* buffer per la risposta */) {
          messages.unshift(message); // Aggiungi all'inizio per mantenere l'ordine corretto
          currentTokenCount += messageTokenCount;
        } else {
          console.log("History truncation: max tokens reached for history part.");
          break; // Ferma se superiamo il limite di token per la cronologia
        }
      }
      messages.reverse(); // Riporta all'ordine cronologico corretto (system, old_user, old_assistant, ...)
      // Assicurati che systemMessage sia il primo se non lo è già per qualche motivo
      if (messages.length === 0 || messages[0].role !== 'system') {
        messages.unshift(systemMessage);
      } else if (messages[0].role === 'system' && messages.length > 1 && messages[1].role === 'system') {
        // Evita system prompt duplicati se per errore è in history
        messages.shift();
      }

    } else {
      // Nessuna cronologia fornita o non è un array, usa solo il system prompt
      console.warn("No history provided or history is not an array.");
    }

    // Aggiungi il prompt corrente dell'utente alla fine
    messages.push({ role: "user", content: prompt });

    console.log("Sending messages to OpenAI:", JSON.stringify(messages, null, 2));


    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: messages, // Usa l'array di messaggi costruito
      temperature: 0.7,
      max_tokens: 150, // Potresti volerlo rendere più dinamico o aumentarlo un po'
    });

    const reply = completion.choices[0].message.content;
    res.status(200).json({ reply });

  } catch (error) {
    console.error('OpenAI API Error (chat):', error.status, error.message, error.response ? JSON.stringify(error.response.data, null, 2) : 'No response data');
    
    let userErrorMessage = 'Errore nel contattare il servizio AI (chat).';
    if (error.response && error.response.data && error.response.data.error) {
        userErrorMessage = error.response.data.error.message || userErrorMessage;
    } else if (error.message) {
        userErrorMessage = error.message;
    }

    let statusCode = error.status || 500;
    if (error.response && error.response.status) {
        statusCode = error.response.status;
    }
    
    // Messaggi specifici per codici di stato
    if (statusCode === 401) {
        userErrorMessage = 'Errore di autenticazione con il servizio AI. Controlla la chiave API.';
    } else if (statusCode === 403) {
        userErrorMessage = `Il progetto non ha accesso al modello AI specificato. (Errore: ${statusCode})`;
    } else if (statusCode === 429) {
        userErrorMessage = 'Hai superato i limiti di richieste al servizio AI. Riprova più tardi.';
    }
    
    res.status(statusCode).json({ error: userErrorMessage });
  }
}
