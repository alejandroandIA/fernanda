// api/tts.js
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY_FERNANDA,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Text is required for TTS' });
  }

  if (!process.env.OPENAI_API_KEY_FERNANDA) {
    return res.status(500).json({ error: 'OpenAI API key not configured.' });
  }

  try {
    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: "alloy", // Puoi scegliere tra: alloy, echo, fable, onyx, nova, shimmer
      input: text,
      response_format: "mp3", // o opus, aac, flac
    });

    // Imposta l'header corretto per lo streaming audio
    res.setHeader('Content-Type', 'audio/mpeg');
    
    // Converte il ReadableStream dal SDK in un Buffer e lo invia,
    // oppure lo pipe direttamente se Vercel lo gestisce bene
    const audioStream = mp3.body; // Questo è un ReadableStream

    // Pipe lo stream direttamente alla risposta
    // Questo è il modo più efficiente per Vercel
    audioStream.pipe(res);
    
    // Non chiamare res.send() o res.end() qui, pipe() lo farà per te
    // Quando lo stream finisce, la risposta sarà automaticamente terminata.

  } catch (error) {
    console.error('OpenAI API Error (TTS):', error);
    // In caso di errore, assicurati di inviare una risposta JSON
    // per non confondere il client che si aspetta un blob audio
    if (!res.headersSent) {
        res.status(500).json({ error: error.message || 'Failed to generate speech' });
    }
  }
}
