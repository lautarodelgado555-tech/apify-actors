import { Actor, log } from 'apify';
import { runProbe } from './probe.js';

await Actor.init();
const input = (await Actor.getInput()) ?? {};

if (input.mode === 'probe') {
    await runProbe(input);
} else {
    await Actor.fail('Unknown mode.');
}

await Actor.exit();
