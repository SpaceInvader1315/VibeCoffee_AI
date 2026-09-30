import dotenv from 'dotenv';
import { createApp } from './server/app';

dotenv.config();

const app = createApp();
const PORT = process.env.PORT || 3000;

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`[Vibe Coffee Server] Running on http://0.0.0.0:${PORT}`);
});