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
      model: "gpt-4o-mini", // Usiamo gpt-4o-mini per velocità e costi, puoi cambiarlo
      messages: [
        { role: "system", content: "Sei Fernanda, un'assistente vocale AI amichevole, utile e concisa. Rispondi in italiano." },
        { role: "user", content: prompt }
      ],
      temperature: 0.7, // Un po' di creatività ma non troppa
      max_tokens: 150,  // Limita la lunghezza della risposta
    });

    const reply = completion.choices[0].message.content;
    res.status(200).json({ reply });

  } catch (error) {
    console.error('OpenAI API Error (chat):', error.response ? error.response.data : error.message);
    let userErrorMessage = 'Errore nel contattare il servizio AI (chat).';
    if (error.status === 401) {
        userErrorMessage = 'Errore di autenticazione con il servizio AI. Controlla la chiave API.';
    } else if (error.status === 429) {
        userErrorMessage = 'Hai superato i limiti di richieste al servizio AI. Riprova più tardi.';
    }
    res.status(500).json({ error: userErrorMessage });
  }
}
