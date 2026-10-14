// Builds small fixture pages from real message markup captured in out2/features.json (poll, voice, round video, inline buttons).
import fs from 'node:fs';
const f = JSON.parse(fs.readFileSync(new URL('./out2/features.json', import.meta.url), 'utf8'));
const dest = process.argv[2];
for (const [key, name] of [['tgme_widget_message_poll', 'poll'], ['tgme_widget_message_voice', 'voice'], ['tgme_widget_message_roundvideo', 'roundvideo'], ['tgme_widget_message_inline_button', 'buttons'], ['tgme_widget_message_forwarded_from_author', 'forwarded-author']]) {
    const html = `<!DOCTYPE html><html><head><title>fixture ${name}</title></head><body><main><section class="tgme_channel_history js-message_history">${f[key].html}</section></main></body></html>`;
    fs.writeFileSync(`${dest}/message-${name}.html`, html);
    console.log(name, f[key].channel, f[key].post, html.length);
}
