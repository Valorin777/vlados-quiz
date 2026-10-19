// DEV-only rehearsal of the panel (`?env=dev&demo=1#/admin`): the real Shell on the simulator.

import { useEffect, useState } from 'react';
import { makeSession, SessionProvider, type AdminSession } from '../core/session';
import { Shell } from '../shell/Shell';
import { Btn } from '../ui/kit';
import { rehearsalBackend, SimHost } from './sim';

export function Rehearsal() {
  const [st] = useState(() => {
    const sim = new SimHost(null);
    const exit = () => {
      const u = new URL(location.href);
      u.searchParams.delete('demo');
      location.href = u.toString();
    };
    const session: AdminSession = makeSession({ uid: 'rehearsal', email: 'репетиция@пульт', emailVerified: true }, sim, rehearsalBackend(sim, exit));
    session.content.attach();
    return { sim, session, exit };
  });
  useEffect(() => {
    // DEV tools (QA scripts): the in-memory backend — upload test media, write the content
    (window as unknown as { __demo?: unknown }).__demo = { sim: st.sim, session: st.session };
    st.sim.start();
    return () => st.sim.stop();
  }, [st]);
  return (
    <SessionProvider session={st.session}>
      <div className="ad-rehearsal" role="note">
        <span>
          <b>Репетиция</b> — игра понарошку, в базу ничего не уходит
        </span>
        <Btn size="s" icon="users" onClick={() => st.sim.addBots(3)}>
          +3 гостя-бота
        </Btn>
        <Btn size="s" tone="ghost" icon="logout" onClick={st.exit}>
          Выйти
        </Btn>
      </div>
      <Shell />
    </SessionProvider>
  );
}
