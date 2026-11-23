import { element } from './media.mjs';
import { folderLabel, getFolderSettings, maxSaveFolders, selectedFolder } from './save-folder.mjs';

const $ = id => document.getElementById(id);

export function createFolderControls(scope, {onRefresh, saveWaiting, notice}) {
  const extensionName = chrome.runtime.getManifest().name;
  const channel = new BroadcastChannel('embedded-video-save-folder-' + scope);
  let active, version = 0;

  async function apply(action, fields) {
    // The worker owns the commit even if the list closes immediately after this click.
    const worker = navigator.serviceWorker.controller || (await navigator.serviceWorker.ready).active;
    const {port1, port2} = new MessageChannel();
    let timer;
    try {
      const reply = new Promise((resolve, reject) => {
        // After unpacking an update, Chrome may still be running the previous worker.
        timer = setTimeout(() => reject(new Error('保存先の設定に応答がありません。取得・保存が終わったら、Chromeの拡張機能画面で「' + extensionName + '」を再読み込みし、一覧を開き直してください。')), 10000);
        port1.onmessage = ({data}) => {
          clearTimeout(timer);
          if (data.received) return;
          if (data.error) reject(new Error(data.error)); else resolve(data);
        };
        port1.onmessageerror = () => reject(new Error('保存先の変更結果を読み取れませんでした。'));
      });
      worker.postMessage({op:'update-save-folders', action, ...fields}, [port2]);
      const result = await reply;
      $('folder-feedback').textContent = action === 'register' && !result.changed ? 'このフォルダーは登録済みです。' : '';
      await refresh();
    } finally { clearTimeout(timer); port1.close(); }
  }

  const controls = Array.from({length:maxSaveFolders}, () => {
    const button = element('button', '', 'quiet folder-option');
    const line = element('div', '', 'registered-folder');
    const name = element('span'), remove = element('button', '登録を解除', 'quiet');
    button.hidden = line.hidden = true;
    button.onclick = () => apply('select', {id:button.dataset.id}).catch(notice);
    remove.onclick = () => apply('remove', {id:button.dataset.id}).catch(notice);
    line.append(name, remove);
    $('folder-presets').append(button);
    $('registered-folders').append(line);
    return {button, line, name, remove};
  });

  async function refresh() {
    const ticket = ++version;
    const settings = await getFolderSettings(scope);
    const selected = selectedFolder(settings);
    const granted = selected && await selected.handle.queryPermission({mode:'readwrite'}).catch(() => 'denied') === 'granted';
    if (ticket !== version) return;
    active = selected;
    const count = settings.slots.filter(Boolean).length;
    for (const [index, ui] of controls.entries()) {
      const entry = settings.slots[index];
      ui.button.hidden = ui.line.hidden = !entry;
      if (!entry) continue;
      const label = folderLabel(settings, entry);
      ui.button.dataset.id = entry.id;
      ui.button.textContent = ui.name.textContent = label;
      ui.button.setAttribute('aria-pressed', String(entry.id === settings.activeId));
      ui.remove.setAttribute('aria-label', label + 'の登録を解除');
    }
    const status = selected ? folderLabel(settings, selected) + (granted ? '（自動保存）' : '（書き込み許可が必要）') : '毎回選択';
    if ($('folder-name').textContent !== status) $('folder-name').textContent = status;
    $('folder-count').textContent = '登録 ' + count + ' / ' + maxSaveFolders;
    $('folder-count').hidden = !count;
    $('folder-presets').hidden = $('clear-folder').hidden = $('manage-folders').hidden = !count;
    $('clear-folder').setAttribute('aria-pressed', String(!selected));
    $('choose-folder').textContent = count ? '保存先を追加' : '保存先を指定';
    const full = count >= maxSaveFolders;
    const adding = document.activeElement === $('choose-folder');
    $('choose-folder').hidden = $('choose-folder').disabled = full;
    if (full && adding) controls[controls.length - 1].button.focus({preventScroll:true});
    $('grant-folder').hidden = !selected || granted;
    onRefresh(selected?.handle);
  }

  async function authorize() {
    const target = active;
    if (!target) throw new Error('一覧から保存先を選んでください。');
    const permission = await target.handle.requestPermission({mode:'readwrite'});
    channel.postMessage('changed');
    await refresh();
    if (active?.id !== target.id) throw new Error('保存先が切り替わりました。一覧で現在の保存先を確認してください。');
    if (permission !== 'granted') throw new Error('自動保存には、指定したフォルダーへの書き込み許可が必要です。取得済みの動画は保存待ちです。');
  }

  $('choose-folder').onclick = async () => {
    try {
      const handle = await showDirectoryPicker({id:'video-save-folder', mode:'readwrite', startIn:active?.handle || 'downloads'});
      await apply('register', {handle});
    } catch (error) { if (error.name !== 'AbortError') notice(error); }
  };
  $('clear-folder').onclick = () => apply('select', {id:null}).catch(notice);
  $('grant-folder').onclick = () => authorize().then(saveWaiting).catch(notice);
  channel.onmessage = () => refresh().catch(notice);
  window.addEventListener('focus', () => refresh().catch(notice));
  return {refresh, authorize};
}
