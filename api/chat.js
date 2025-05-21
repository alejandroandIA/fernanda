// api/chat.js
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY_FERNANDA,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  if (!process.env.OPENAI_API_KEY_FERNANDA) {
    return res.status(500).json({ error: 'OpenAI API key not configured.' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // o gpt-3.5-turbo, gpt-4o-mini, etc.
      messages: [
        { role: "system", content: "Sei un assistente vocale amichevole e conciso di nome Fernanda." },
        { role: "user", content: prompt }
      ],
    });

    const reply = completion.choices[0].message.content;
    res.status(200).json({ reply });

  } catch (error) {
    console.error('OpenAI API Error (chat):', error);
    res.status(500).json({ error: error.message || 'Failed to get response from OpenAI' });
  }
}
