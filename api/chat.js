// api/chat.js
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY_FERNANDA,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  if (!process.env.OPENAI_API_KEY_FERNANDA) {
    console.error('OPENAI_API_KEY_FERNANDA not configured');
    return res.status(500).json({ error: 'Server configuration error: OpenAI API key missing.' });
  }

  try {
    const completion = await openai.chat.completions.create({
      // --- MODIFICA QUI SOTTO ---
      model: "gpt-4o", // Utilizziamo gpt-4o che è attivo sul tuo account
      // --- FINE MODIFICA ---
      messages: [
        { role: "system", content: "Sei Fernanda, un'assistente vocale AI amichevole, utile e concisa. Rispondi in italiano, in modo naturale come se stessi parlando." },
        { role: "user", content: prompt }
      ],
      temperature: 0.7, 
      max_tokens: 150,  
    });

    const reply = completion.choices[0].message.content;
    res.status(200).json({ reply });

  } catch (error) {
    // Questa parte logga l'errore sui server di Vercel, utile per il debug
    console.error('OpenAI API Error (chat):', error.status, error.message, error.response ? error.response.data : 'No response data');
    
    // Questo è il messaggio che l'utente potrebbe vedere se non gestito diversamente nel frontend
    let userErrorMessage = 'Errore nel contattare il servizio AI (chat).';
    if (error.status === 401) {
        userErrorMessage = 'Errore di autenticazione con il servizio AI. Controlla la chiave API.';
    } else if (error.status === 403) { // Errore specifico per permessi/modello
        userErrorMessage = `Il progetto non ha accesso al modello AI specificato. (Errore: ${error.status})`;
    } else if (error.status === 429) {
        userErrorMessage = 'Hai superato i limiti di richieste al servizio AI. Riprova più tardi.';
    }
    res.status(error.status || 500).json({ error: userErrorMessage });
  }
}
