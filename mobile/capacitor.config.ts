import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ch.elsiga.odysseus',
  appName: 'Odysseus',
  webDir: 'www',
  server: {
    url: 'https://chat.elsiga.ch',
    cleartext: false,
  },
};

export default config;
