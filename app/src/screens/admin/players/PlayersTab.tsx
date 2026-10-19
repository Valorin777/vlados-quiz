// «Игроки»: everyone who joined — rename, kick / return, mark Vlados (out of competition).

import { FB_LIMITS } from '@shared/fbtypes';
import { useMemo, useState } from 'react';
import type { TvPlayer } from '../../../host';
import { checkedName } from '../../../host/pure';
import { Modal, cx, toast } from '../../../visual';
import { fmtAgo, nPlayers } from '../core/format';
import { useAdmin, useAdminView } from '../core/session';
import { Btn, Card, Empty, Field, IconBtn, PageHead, TextInput } from '../ui/kit';
import { PlayerAvatar } from '../ui/people';

function RenameModal({ p, onClose }: { p: TvPlayer | null; onClose: () => void }) {
  const { run } = useAdmin();
  const [name, setName] = useState(p?.name ?? '');
  const [key, setKey] = useState(p?.uid);
  if (p && p.uid !== key) {
    setKey(p.uid);
    setName(p.name);
  }
  const ok = checkedName(name);
  return (
    <Modal open={!!p} onClose={onClose} title="Переименовать">
      <form
        className="ad-sheet-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!p || !ok) return;
          if (await run({ type: 'rename', uid: p.uid, name: ok }, 'Имя обновлено')) onClose();
        }}
      >
        <Field label="Имя на экране" hint={`До ${FB_LIMITS.nameMax} символов. Гость увидит новое имя у себя.`} error={name && !ok ? 'Слишком длинное или пустое имя' : null}>
          <TextInput value={name} onChange={setName} maxLength={FB_LIMITS.nameMax} autoFocus />
        </Field>
        <div className="ad-sheet-actions">
          <Btn tone="ghost" onClick={onClose}>
            Отмена
          </Btn>
          <Btn type="submit" tone="chrome" disabled={!ok}>
            Сохранить
          </Btn>
        </div>
      </form>
    </Modal>
  );
}

export function PlayersTab() {
  const v = useAdminView(1000);
  const { run } = useAdmin();
  const [q, setQ] = useState('');
  const [renaming, setRenaming] = useState<TvPlayer | null>(null);
  const [showKicked, setShowKicked] = useState(false);
  const all = v.allPlayers;
  const kickedCount = all.filter((p) => p.kicked).length;
  const list = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase('ru');
    return all
      .filter((p) => showKicked || !p.kicked)
      .filter((p) => !needle || p.name.toLocaleLowerCase('ru').includes(needle))
      .sort((a, b) => Number(b.isVlados) - Number(a.isVlados) || b.joinedAt - a.joinedAt);
  }, [all, q, showKicked]);

  return (
    <>
      <PageHead
        kicker={`${nPlayers(v.players.length)} в игре${kickedCount ? ` · ${kickedCount} удалено` : ''}`}
        title="Игроки"
        sub="Гости появляются здесь, как только введут имя. Отметь Владоса — он играет вне конкурса, а в финале его сравнят с друзьями."
      />
      <Card>
        <div className="ad-row" style={{ marginBottom: 8, flexWrap: 'nowrap' }}>
          <TextInput value={q} onChange={setQ} placeholder="Найти по имени" icon="search" className="ad-grow" />
          {kickedCount ? (
            <Btn tone={showKicked ? 'chrome' : 'plain'} size="m" onClick={() => setShowKicked(!showKicked)}>
              Удалённые · {kickedCount}
            </Btn>
          ) : null}
        </div>
        {list.length ? (
          <div className="ad-plist">
            {list.map((p) => (
              <div key={p.uid} className={cx('ad-prow', p.kicked && 'is-kicked')}>
                <PlayerAvatar p={p} size={40} big />
                <div style={{ minWidth: 0 }}>
                  <div className="ad-prow-name">
                    <span>{p.name}</span>
                    {p.isVlados ? <span className="ad-tag is-film">Владос</span> : null}
                    {p.kicked ? <span className="ad-tag is-bad">удалён</span> : null}
                    {p.answered ? <span className="ad-tag is-good">ответил</span> : null}
                  </div>
                  <div className="ad-prow-sub">зашёл {fmtAgo(v.now - p.joinedAt)}</div>
                </div>
                <div className="ad-prow-actions">
                  <IconBtn
                    icon="crown"
                    label={p.isVlados ? 'Снять отметку «Владос»' : 'Это Владос'}
                    tone={p.isVlados ? 'accent' : 'plain'}
                    onClick={() => void run({ type: 'setVlados', uid: p.isVlados ? null : p.uid }, p.isVlados ? 'Отметка снята' : `${p.name} — это Владос 👑`)}
                  />
                  <IconBtn icon="edit" label="Переименовать" onClick={() => setRenaming(p)} />
                  {p.kicked ? (
                    <IconBtn icon="restore" label="Вернуть в игру" onClick={() => void run({ type: 'unkick', uid: p.uid }, `${p.name} снова в игре`)} />
                  ) : (
                    <IconBtn
                      icon="x"
                      label="Удалить из игры"
                      tone="danger"
                      onClick={() => {
                        void run({ type: 'kick', uid: p.uid }).then((ok) => ok && toast(`${p.name} удалён из игры`, { tone: 'info' }));
                      }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon="users" title={all.length ? 'Никого не нашёл' : 'Пока никто не зашёл'} text={all.length ? 'Попробуй другое имя.' : 'Гости заходят по QR-коду с экрана ТВ или по ссылке.'} />
        )}
      </Card>
      <RenameModal p={renaming} onClose={() => setRenaming(null)} />
    </>
  );
}
