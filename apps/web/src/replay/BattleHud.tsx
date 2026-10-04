import type { SceneModel } from './scene-model.ts';

/** Read-only HUD from the same recorded model as both renderers. No simulated resources. */
export function BattleHud({ model }: { model: SceneModel }) {
  return (
    <div className="battle-hud" aria-label="対戦者のHP">
      {model.actors.map((actor, index) => (
        <div className="duelist" data-side={index === 0 ? 'left' : 'right'} key={actor.id}>
          <span className="duelist-sigil" aria-hidden="true">
            {String(index + 1).padStart(2, '0')}
          </span>
          <div className="duelist-info">
            <span className="eyebrow">{index === 0 ? 'CHALLENGER' : 'OPPONENT'}</span>
            <h3>{actor.name}</h3>
            {actor.hp ? (
              <>
                <meter
                  aria-label={`${actor.name} HP`}
                  min={0}
                  max={Math.max(1, actor.hp.max)}
                  value={actor.hp.value}
                />
                <span className="duelist-resource">
                  HP <strong>{actor.hp.value}</strong> / {actor.hp.max}
                </span>
              </>
            ) : (
              <span className="duelist-resource">HP 記録なし</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
