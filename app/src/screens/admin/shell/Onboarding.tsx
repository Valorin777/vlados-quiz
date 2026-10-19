// First run: admin/content does not exist yet → start from 6 templates or from an empty game.

import { useState } from 'react';
import { ChromeBlock, ChromeText, toast } from '../../../visual';
import { useAdmin } from '../core/session';
import { Icon } from '../ui/icons';

export function Onboarding() {
  const { backend } = useAdmin();
  const [busy, setBusy] = useState<'tpl' | 'empty' | null>(null);

  const start = async (withTemplates: boolean) => {
    setBusy(withTemplates ? 'tpl' : 'empty');
    try {
      const r = await backend.seed(withTemplates);
      toast(r === 'created' ? (withTemplates ? '6 шаблонов готовы — переделывай под Владоса!' : 'Чистый лист — добавляй вопросы') : 'Игра уже создана на другом устройстве', {
        tone: 'good',
      });
    } catch {
      toast('Не получилось создать игру — проверь интернет', { tone: 'bad' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ad-onboard">
      <p className="vx-kick">Первый запуск</p>
      <ChromeText as="h1" className="ad-page-title" size="h1">
        С чего начнём?
      </ChromeText>
      <p className="ad-page-sub" style={{ margin: '12px auto 0' }}>
        Всё можно поменять потом: вопросы, тексты, время, оформление. Гостям ничего не видно, пока ты не нажмёшь «Начать игру».
      </p>
      <div className="ad-onboard-grid">
        <button type="button" className="ad-choice-card" disabled={busy !== null} onClick={() => void start(true)}>
          <ChromeBlock shape="circle" className="ad-choice-orb" film={0.95} liquid={false}>
            <Icon name="sparkle" size={24} />
          </ChromeBlock>
          <h3>{busy === 'tpl' ? 'Создаю…' : 'Начать с 6 шаблонов'}</h3>
          <p className="ad-hint">
            Готовые вопросы всех трёх типов: выбор варианта, число и «по порядку». Замени текст, ответы и фото — и игра готова.
          </p>
          <span className="ad-tag is-film">Советую</span>
        </button>
        <button type="button" className="ad-choice-card" disabled={busy !== null} onClick={() => void start(false)}>
          <ChromeBlock shape="circle" className="ad-choice-orb" film={0.3} liquid={false}>
            <Icon name="plus" size={24} />
          </ChromeBlock>
          <h3>{busy === 'empty' ? 'Создаю…' : 'Пустая игра'}</h3>
          <p className="ad-hint">Чистый лист: все вопросы придумаешь сам. Настройки — по умолчанию.</p>
        </button>
      </div>
    </div>
  );
}
