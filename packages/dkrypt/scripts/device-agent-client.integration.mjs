import { withSSH } from '../src/idevice.ts';

const transport = await withSSH(
  { transport: 'usb', udid: 'fixture-device' },
  async (device) => device.transport,
);

if (transport !== 'autoinstall') throw new Error(`expected the autoinstall transport, received ${transport}`);

process.stdout.write('DKRYPT_RPC_OK');
