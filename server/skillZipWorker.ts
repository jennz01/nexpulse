// Worker side of inspectInWorker: unzips and checks the skill zip off the server's main thread.
import { inspectSkillZip, SkillZipError } from './skillInstall';

declare const self: Worker;

self.onmessage = (ev: MessageEvent<Uint8Array>) => {
  try {
    const { files, version } = inspectSkillZip(ev.data);
    self.postMessage({ ok: true, files: [...files], version });
  } catch (e) {
    self.postMessage({ ok: false, error: (e as Error).message, zip: e instanceof SkillZipError });
  }
};
