import { deepFreeze } from './spatial/canonical.ts';
import {
  SKILL_DANS,
  SKILL_ZODIACS,
  type SkillDan,
  type SkillNode,
  type SkillZodiacId,
} from './skill-system.ts';

export const ILLUSION_CURSE_PATH_ID = 'illusion-curse' as const;

export type IllusionCurseTechnique = 'curse' | 'mind' | 'illusion' | 'counter';
export type IllusionModality = 'none' | 'visual' | 'audio' | 'presence' | 'multi';
export type IllusionTarget = 'sentient-enemy' | 'sensory-observer' | 'area-observers' | 'self';
export type IllusionDefense =
  | 'curse-resistance'
  | 'mental-resistance'
  | 'illusion-detection'
  | 'none';
export type IllusionCounter = 'resist' | 'discover' | 'cleanse' | 'expiry';

export const ILLUSION_CURSE_MISSING_MECHANISMS = deepFreeze({
  'curse-defense-v1':
    'A distinct curse resistance and removal selector; elemental resistance and generic status visibility are not substitutes.',
  'mental-eligibility-v1':
    'An explicit sentient or mindless target trait, independent of appearance, path and character ID.',
  'mental-defense-v1':
    'A finite mental resistance contract distinct from curse resistance and illusion discovery.',
  'sensory-cue-visual-v1':
    'Bounded per-observer visual cues with sight occlusion, delivery delay, memory and perceived origin.',
  'sensory-cue-audio-v1':
    'Bounded per-observer sound cues with their own range, occlusion, delay and memory instead of sight reuse.',
  'sensory-cue-presence-v1':
    'A defined presence sensor and false-presence delivery profile, separate from visual and audio sensing.',
  'sensory-cue-counter-v1':
    'Atomic resistance, discovery, cleanse and expiry transitions that each settle and record exactly once.',
  'perceived-target-ai-v1':
    'AI candidates may select a recorded perceived cue position without resolving the cue ID as a combat actor.',
  'sensory-cue-record-replay-v1':
    'Versioned truth and subjective cue records, artifact validation and engine-free ReplayState reconstruction for both viewers.',
  'illusion-curse-definition-v1':
    'An immutable reviewed ability or status revision with approved numbers and an exact skill resolution reference.',
});

type NodePlan = {
  name: string;
  behavior: string;
  lowerUse: string;
  technique: IllusionCurseTechnique;
  modality: IllusionModality;
  target: IllusionTarget;
  defense: IllusionDefense;
  counters: readonly IllusionCounter[];
  conditionOrTradeoff?: string;
};

type BranchPlan = {
  zodiac: SkillZodiacId;
  role: string;
  nodes: readonly [NodePlan, NodePlan, NodePlan, NodePlan, NodePlan, NodePlan];
};

const n = (
  name: string,
  behavior: string,
  lowerUse: string,
  technique: IllusionCurseTechnique,
  modality: IllusionModality,
  target: IllusionTarget,
  defense: IllusionDefense,
  counters: readonly IllusionCounter[],
  conditionOrTradeoff?: string,
): NodePlan => ({
  name,
  behavior,
  lowerUse,
  technique,
  modality,
  target,
  defense,
  counters,
  ...(conditionOrTradeoff ? { conditionOrTradeoff } : {}),
});

export const ILLUSION_CURSE_BRANCH_PLANS = deepFreeze([
  {
    zodiac: 'rat',
    role: 'initiative through early misdirection and fast finite hindrance',
    nodes: [
      n(
        'First Mark',
        'Places a short curse before a longer setup can begin.',
        'It remains the cheapest immediate curse.',
        'curse',
        'none',
        'sentient-enemy',
        'curse-resistance',
        ['resist', 'cleanse', 'expiry'],
      ),
      n(
        'Startle Whisper',
        'Adds a delayed false sound that competes with the first observed threat.',
        'First Mark remains reliable when sound cannot reach the observer.',
        'illusion',
        'audio',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Marked Opening',
        'Links the mark to one false visual opening after the mark is observed.',
        'The unlinked mark remains faster and does not require cue delivery.',
        'illusion',
        'visual',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Forked Omen',
        'Chooses visual or audio initiative according to the observed route.',
        'Earlier single-modality tools remain cheaper and predictable.',
        'illusion',
        'multi',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Pre-emptive Dread',
        'Applies finite hesitation only before the target has committed an action.',
        'First Mark works after the opening window has passed.',
        'mind',
        'none',
        'sentient-enemy',
        'mental-resistance',
        ['resist', 'cleanse', 'expiry'],
        'Fails after commitment and exposes a longer recovery.',
      ),
      n(
        'First Nightmare',
        'Combines one early mental interruption with one bounded false approach cue.',
        'The lower tools isolate one effect with less cost and recovery.',
        'mind',
        'multi',
        'sentient-enemy',
        'mental-resistance',
        ['resist', 'discover', 'cleanse', 'expiry'],
        'Consumes the branch reserve, has a long cooldown and cannot repeat its interruption.',
      ),
    ],
  },
  {
    zodiac: 'ox',
    role: 'bounded accumulation and sustained curse pressure',
    nodes: [
      n(
        'Lingering Burden',
        'Applies one finite burden that increases declared exertion.',
        'It is the low-maintenance single burden.',
        'curse',
        'none',
        'sentient-enemy',
        'curse-resistance',
        ['resist', 'cleanse', 'expiry'],
      ),
      n(
        'Second Weight',
        'Allows a second bounded application under an explicit stack cap.',
        'Lingering Burden avoids the extra upkeep.',
        'curse',
        'none',
        'sentient-enemy',
        'curse-resistance',
        ['resist', 'cleanse', 'expiry'],
      ),
      n(
        'Burdened Rhythm',
        'Links maintained burden to a periodic but finite concentration check.',
        'The plain burden does not depend on periodic timing.',
        'mind',
        'none',
        'sentient-enemy',
        'mental-resistance',
        ['resist', 'cleanse', 'expiry'],
      ),
      n(
        'Stored Murmur',
        'Stores one audio cue while burden persists and delivers it on movement.',
        'Earlier pressure remains useful against an observer without audio sensing.',
        'illusion',
        'audio',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Patient Malediction',
        'Extends one existing curse instead of adding another stack.',
        'Short burdens remain easier to apply and release sooner.',
        'curse',
        'none',
        'sentient-enemy',
        'curse-resistance',
        ['resist', 'cleanse', 'expiry'],
        'Requires an existing curse and continuous upkeep; cleanse removes the investment.',
      ),
      n(
        'Oxen Nightmare',
        'Converts accumulated burden into a finite multi-modal distraction.',
        'Accumulated curses retain value when conversion would be wasteful.',
        'illusion',
        'multi',
        'sentient-enemy',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
        'Consumes all branch accumulation and leaves a long unprotected recovery.',
      ),
    ],
  },
  {
    zodiac: 'tiger',
    role: 'mental pressure and explicit intimidation without unconditional control',
    nodes: [
      n(
        'Threatening Gaze',
        'Applies brief finite hesitation after a visible hostile approach.',
        'It remains the direct low-cost pressure tool.',
        'mind',
        'none',
        'sentient-enemy',
        'mental-resistance',
        ['resist', 'cleanse', 'expiry'],
      ),
      n(
        'Roaring Echo',
        'Adds a false hostile sound when hesitation is successfully observed.',
        'Threatening Gaze works in silence and at closer range.',
        'illusion',
        'audio',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Predator Silhouette',
        'Combines pressure with one false advancing visual silhouette.',
        'The gaze remains safer because it creates no alternate target.',
        'illusion',
        'visual',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Cornering Dread',
        'Selects pressure direction from the target’s delivered position and terrain.',
        'Earlier pressure does not require favorable geometry.',
        'mind',
        'none',
        'sentient-enemy',
        'mental-resistance',
        ['resist', 'cleanse', 'expiry'],
      ),
      n(
        'Dominating Presence',
        'Adds false presence only while the target remains inside a declared pressure zone.',
        'Threatening Gaze remains usable outside the zone.',
        'illusion',
        'presence',
        'area-observers',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
        'Requires maintained range and ends immediately when the zone is left.',
      ),
      n(
        'Tiger Terror',
        'Attempts one strong finite retreat impulse through mental pressure, never forced motion.',
        'Lower pressure preserves control and costs less when retreat is unnecessary.',
        'mind',
        'none',
        'sentient-enemy',
        'mental-resistance',
        ['resist', 'cleanse', 'expiry'],
        'Requires prior observed pressure, finite uses and a long recovery; mindless targets are ineligible.',
      ),
    ],
  },
  {
    zodiac: 'rabbit',
    role: 'escape through decoys while preserving real collision and victory truth',
    nodes: [
      n(
        'Side-Step Image',
        'Emits one visual cue beside the creator during withdrawal.',
        'It remains the inexpensive single decoy.',
        'illusion',
        'visual',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Retreating Footfall',
        'Adds a false sound moving away on a separate delivery profile.',
        'Side-Step Image remains useful to observers without audio sensing.',
        'illusion',
        'audio',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Crossed Escape',
        'Pairs the image and footfall in opposing directions after movement begins.',
        'Single cues remain cheaper and reveal less of the escape timing.',
        'illusion',
        'multi',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Vanishing Trail',
        'Switches between visual, audio and presence trails based on observed pursuit.',
        'Crossed Escape remains deterministic without a modality choice.',
        'illusion',
        'multi',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Borrowed Exit',
        'Places a bounded decoy at an observed clear escape point.',
        'Side-Step Image works without surveyed clearance.',
        'illusion',
        'visual',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
        'Requires a legally observed clear point and fizzles without one.',
      ),
      n(
        'Moon-Rabbit Flight',
        'Leaves a short chain of cues while the creator commits to retreat.',
        'Earlier decoys preserve freedom to counterattack.',
        'illusion',
        'multi',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
        'Consumes sustained resources, forbids attacking during emission and has a strict cue cap.',
      ),
    ],
  },
  {
    zodiac: 'dragon',
    role: 'bounded area influence through curses and observer-specific cue fields',
    nodes: [
      n(
        'Cursed Circle',
        'Applies a finite curse only inside a declared area.',
        'Single-target curses remain cheaper and follow a moving target.',
        'curse',
        'none',
        'area-observers',
        'curse-resistance',
        ['resist', 'cleanse', 'expiry'],
      ),
      n(
        'Echoing Circle',
        'Adds false sounds delivered only to eligible observers inside the area.',
        'Cursed Circle still works when sound is blocked or unsupported.',
        'illusion',
        'audio',
        'area-observers',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Mirrored Circle',
        'Combines area curse timing with bounded visual cues at fixed clear points.',
        'Echoing Circle uses fewer cues and no visual line of sight.',
        'illusion',
        'visual',
        'area-observers',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Shifting Domain',
        'Changes the emitted modality at explicit area phase boundaries.',
        'Earlier circles keep one stable modality with lower upkeep.',
        'illusion',
        'multi',
        'area-observers',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Hidden Boundary',
        'Conceals the area edge with cues but never changes real collision or area membership.',
        'Cursed Circle exposes its boundary and is easier to maintain.',
        'illusion',
        'visual',
        'area-observers',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
        'Requires continuous upkeep; discovery reveals the true boundary immediately.',
      ),
      n(
        'Dragon Mirage Field',
        'Runs a capped multi-modal field whose cues remain per observer.',
        'Smaller circles retain precision and lower artifact cost.',
        'illusion',
        'multi',
        'area-observers',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
        'Uses the maximum field reserve, strict active-cue caps and a long recovery after collapse.',
      ),
    ],
  },
  {
    zodiac: 'snake',
    role: 'finite restraint and continuing pressure with explicit escape and cleanse paths',
    nodes: [
      n(
        'Binding Word',
        'Applies a short action-slowing curse without physical restraint.',
        'It remains the direct finite restraint tool.',
        'curse',
        'none',
        'sentient-enemy',
        'curse-resistance',
        ['resist', 'cleanse', 'expiry'],
      ),
      n(
        'Coiling Doubt',
        'Adds mental hesitation when the bound target repeats an action.',
        'Binding Word works without observing repetition.',
        'mind',
        'none',
        'sentient-enemy',
        'mental-resistance',
        ['resist', 'cleanse', 'expiry'],
      ),
      n(
        'False Barrier',
        'Presents one visual obstruction while the curse persists, without collision.',
        'Coiling Doubt remains effective when visual cues are discovered.',
        'illusion',
        'visual',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Closing Whisper',
        'Chooses a false barrier or enclosing sound from observed movement.',
        'False Barrier is cheaper when visual restraint is sufficient.',
        'illusion',
        'multi',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Shed-Skin Hex',
        'Reapplies one finite curse only after the prior curse is cleansed.',
        'Binding Word can be used without waiting for a cleanse event.',
        'curse',
        'none',
        'sentient-enemy',
        'curse-resistance',
        ['resist', 'cleanse', 'expiry'],
        'Consumes a prepared charge and cannot trigger on natural expiry.',
      ),
      n(
        'Serpent Labyrinth',
        'Creates a capped sequence of false exits while maintaining one restraint curse.',
        'Lower restraint retains lower upkeep and simpler counterplay.',
        'illusion',
        'multi',
        'sentient-enemy',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
        'Breaks on cleanse or upkeep failure and imposes a long recovery; cues never block movement.',
      ),
    ],
  },
  {
    zodiac: 'horse',
    role: 'mobile pursuit and moving false trails without hidden-position access',
    nodes: [
      n(
        'Passing Footfall',
        'Emits one false sound from the creator’s delivered movement sample.',
        'It remains the cheap moving cue.',
        'illusion',
        'audio',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Trailing Presence',
        'Adds a delayed false presence behind the sampled route.',
        'Passing Footfall works for ordinary audio observers.',
        'illusion',
        'presence',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Diverging Trail',
        'Pairs sound and presence cues along two bounded projected routes.',
        'Single trails consume fewer cue slots.',
        'illusion',
        'multi',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Pursuit Feint',
        'Changes trail direction only from legally observed pursuer motion.',
        'Diverging Trail remains useful without a current pursuer sample.',
        'illusion',
        'multi',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Galloping Phantom',
        'Adds one moving visual silhouette synchronized to a false trail.',
        'Audio and presence trails remain cheaper and less visible.',
        'illusion',
        'visual',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
        'Requires sustained movement; stopping removes the silhouette at the next boundary.',
      ),
      n(
        'Thousand-League Mirage',
        'Maintains a capped multi-modal moving trail during a committed run.',
        'Earlier trails allow slower movement and immediate action.',
        'illusion',
        'multi',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
        'Drains stamina, forbids casting other skills and ends all cues when the run stops.',
      ),
    ],
  },
  {
    zodiac: 'goat',
    role: 'stable maintenance, recovery from interference and controlled resource use',
    nodes: [
      n(
        'Quiet Breathing',
        'Reduces the self upkeep of one finite curse without extending it.',
        'Unmodified curses remain immediately available without preparation.',
        'curse',
        'none',
        'self',
        'none',
        ['cleanse', 'expiry'],
      ),
      n(
        'Settled Mind',
        'Grants a finite self defense against mental interference.',
        'Quiet Breathing costs less when no mental threat is observed.',
        'counter',
        'none',
        'self',
        'mental-resistance',
        ['expiry'],
      ),
      n(
        'Clear Senses',
        'Links self mental steadiness to one bounded illusion discovery attempt.',
        'Settled Mind remains reliable without spending a discovery attempt.',
        'counter',
        'multi',
        'self',
        'illusion-detection',
        ['discover', 'expiry'],
      ),
      n(
        'Measured Maintenance',
        'Chooses one maintained curse or cue and releases the others cleanly.',
        'Earlier skills allow multiple short effects without maintenance selection.',
        'counter',
        'multi',
        'self',
        'none',
        ['cleanse', 'expiry'],
      ),
      n(
        'Restored Focus',
        'Recovers part of committed focus only after a hostile cue is discovered.',
        'Clear Senses can discover without depending on a recovery reward.',
        'counter',
        'multi',
        'self',
        'illusion-detection',
        ['discover', 'expiry'],
        'Requires an actual recorded discovery and cannot trigger from known truth or self cues.',
      ),
      n(
        'Unclouded Cycle',
        'Alternates one finite curse and one defensive discovery window.',
        'Individual curse and defense skills remain cheaper and can overlap freely.',
        'counter',
        'multi',
        'self',
        'illusion-detection',
        ['discover', 'cleanse', 'expiry'],
        'Locks the user to alternating phases and loses remaining reserve if either phase is cleansed.',
      ),
    ],
  },
  {
    zodiac: 'monkey',
    role: 'adaptation, feints and explicit modality switching',
    nodes: [
      n(
        'False Gesture',
        'Emits one visual action cue that carries no attack or collision.',
        'It remains the simplest low-cost feint.',
        'illusion',
        'visual',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Mimicked Sound',
        'Substitutes an audio action cue when sight is unavailable.',
        'False Gesture is more precise when line of sight exists.',
        'illusion',
        'audio',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Double Feint',
        'Combines a false gesture with a mismatched sound in a fixed order.',
        'Each single cue remains cheaper and less likely to expose the pattern.',
        'illusion',
        'multi',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Adaptive Mask',
        'Selects visual, audio or presence cue from delivered observer evidence.',
        'Double Feint remains deterministic when evidence is absent.',
        'illusion',
        'multi',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Borrowed Tell',
        'Copies only a coarse observed action phase into a false cue.',
        'False Gesture works without first observing an opponent action.',
        'illusion',
        'visual',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
        'Requires a delivered action observation and never copies hidden ability identity or future choice.',
      ),
      n(
        'Monkey’s Empty Stage',
        'Executes a capped sequence of modality changes around one committed action.',
        'Earlier feints preserve freedom to cancel or choose another action.',
        'illusion',
        'multi',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
        'Commits the real action, spends all cue charges and has a long post-action opening.',
      ),
    ],
  },
  {
    zodiac: 'rooster',
    role: 'observation, discovery and counterplay without omniscience',
    nodes: [
      n(
        'Check Reflection',
        'Makes one finite visual discovery attempt using delivered cue evidence.',
        'It remains the cheap single-modality check.',
        'counter',
        'visual',
        'self',
        'illusion-detection',
        ['discover', 'expiry'],
      ),
      n(
        'Listen Twice',
        'Adds a separate audio discovery attempt with its own range and delay.',
        'Check Reflection costs less against purely visual cues.',
        'counter',
        'audio',
        'self',
        'illusion-detection',
        ['discover', 'expiry'],
      ),
      n(
        'Cross-Check Senses',
        'Combines two delivered modalities without reading canonical truth.',
        'Single checks remain faster and preserve the other attempt.',
        'counter',
        'multi',
        'self',
        'illusion-detection',
        ['discover', 'expiry'],
      ),
      n(
        'Trace Contradiction',
        'Uses recorded cue inconsistency to prioritize one discovery candidate.',
        'Cross-Check Senses works when no contradiction has accumulated.',
        'counter',
        'multi',
        'self',
        'illusion-detection',
        ['discover', 'expiry'],
      ),
      n(
        'Expose Source',
        'Reveals only a coarse creator direction after successful discovery.',
        'Trace Contradiction discovers falsehood without exposing a direction.',
        'counter',
        'multi',
        'self',
        'illusion-detection',
        ['discover', 'expiry'],
        'Requires successful discovery and never reveals ability ID, exact position or future action.',
      ),
      n(
        'Dawn Clarity',
        'Runs one bounded all-modality discovery window and marks known-false cues.',
        'Lower checks retain precision, lower cost and shorter commitment.',
        'counter',
        'multi',
        'self',
        'illusion-detection',
        ['discover', 'expiry'],
        'Consumes all detection reserve, has finite duration and cannot cleanse cues by itself.',
      ),
    ],
  },
  {
    zodiac: 'dog',
    role: 'protective wards and responses that preserve distinct resistance and cleanse semantics',
    nodes: [
      n(
        'Curse Ward',
        'Raises finite self curse resistance without removing an existing curse.',
        'It remains the inexpensive preventive ward.',
        'counter',
        'none',
        'self',
        'curse-resistance',
        ['resist', 'expiry'],
      ),
      n(
        'Mind Ward',
        'Provides a separate finite defense against mental interference.',
        'Curse Ward remains cheaper against non-mental curses.',
        'counter',
        'none',
        'self',
        'mental-resistance',
        ['resist', 'expiry'],
      ),
      n(
        'Sense Ward',
        'Adds one bounded discovery attempt while either ward is active.',
        'The resistance wards work without spending detection reserve.',
        'counter',
        'multi',
        'self',
        'illusion-detection',
        ['discover', 'expiry'],
      ),
      n(
        'Responsive Purge',
        'Cleanses one discovered cue or one identified curse at a boundary.',
        'Sense Ward can preserve evidence without removing it.',
        'counter',
        'multi',
        'self',
        'illusion-detection',
        ['discover', 'cleanse', 'expiry'],
      ),
      n(
        'Guarded Reprisal',
        'Opens one response window after a successful resist or cleanse.',
        'Responsive Purge remains available without committing to a counteraction.',
        'counter',
        'none',
        'self',
        'none',
        ['resist', 'cleanse', 'expiry'],
        'Requires a recorded counter event and expires if no legal response is available.',
      ),
      n(
        'Faithful Watch',
        'Maintains one curse ward, one mind ward and one discovery window as separate bounded effects.',
        'Individual wards retain lower upkeep and can be timed independently.',
        'counter',
        'multi',
        'self',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
        'Consumes continuous reserve and loses every layer together when upkeep fails.',
      ),
    ],
  },
  {
    zodiac: 'boar',
    role: 'costly finite breakthrough that never becomes absolute control',
    nodes: [
      n(
        'Piercing Hex',
        'Attempts one stronger finite curse against a prepared defense.',
        'Ordinary curses remain cheaper against unprepared targets.',
        'curse',
        'none',
        'sentient-enemy',
        'curse-resistance',
        ['resist', 'cleanse', 'expiry'],
      ),
      n(
        'Shattering Cry',
        'Pairs the curse attempt with a loud false approach cue.',
        'Piercing Hex remains usable when audio delivery would fail.',
        'illusion',
        'audio',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Rending Apparition',
        'Combines the attempt with one direct visual feint at a clear point.',
        'Shattering Cry retains value behind visual obstruction.',
        'illusion',
        'visual',
        'sensory-observer',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Break the Pattern',
        'Chooses curse pressure or cue pressure from observed counter use.',
        'Earlier attacks work without revealing the chosen response mode.',
        'illusion',
        'multi',
        'sentient-enemy',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
      ),
      n(
        'Lasting Scar',
        'Trades immediate force for a longer but still finite curse after a failed cleanse.',
        'Piercing Hex does not require a prior cleanse attempt.',
        'curse',
        'none',
        'sentient-enemy',
        'curse-resistance',
        ['resist', 'cleanse', 'expiry'],
        'Requires a recorded failed cleanse, consumes finite uses and cannot refresh itself.',
      ),
      n(
        'Boar’s Final Delusion',
        'Commits all reserves to one bounded curse and one multi-modal false target.',
        'Lower skills remain available without exhausting every defense and cue resource.',
        'illusion',
        'multi',
        'sentient-enemy',
        'illusion-detection',
        ['resist', 'discover', 'cleanse', 'expiry'],
        'Finite uses, maximum recovery and self-exposure remain; resistance or discovery can still defeat it.',
      ),
    ],
  },
] as const satisfies readonly BranchPlan[]);

const DEEPENING_KINDS = [
  'foundation',
  'conditional-effect',
  'combination',
  'tactical-mode',
  'specialization',
  'ultimate-tradeoff',
] as const satisfies readonly SkillNode['deepening']['kind'][];

function mechanismIds(plan: NodePlan): string[] {
  const ids = new Set<string>(['illusion-curse-definition-v1']);
  if (plan.technique === 'curse') ids.add('curse-defense-v1');
  if (plan.technique === 'mind') {
    ids.add('mental-eligibility-v1');
    ids.add('mental-defense-v1');
  }
  if (plan.technique === 'counter') ids.add('sensory-cue-counter-v1');
  if (plan.modality === 'visual' || plan.modality === 'multi') ids.add('sensory-cue-visual-v1');
  if (plan.modality === 'audio' || plan.modality === 'multi') ids.add('sensory-cue-audio-v1');
  if (plan.modality === 'presence' || plan.modality === 'multi') ids.add('sensory-cue-presence-v1');
  if (plan.modality !== 'none') {
    ids.add('sensory-cue-counter-v1');
    ids.add('perceived-target-ai-v1');
    ids.add('sensory-cue-record-replay-v1');
  }
  return [...ids].sort();
}

export type IllusionCurseDraftNode = {
  node: SkillNode;
  design: {
    branchRole: string;
    technique: IllusionCurseTechnique;
    modality: IllusionModality;
    target: IllusionTarget;
    defense: IllusionDefense;
    counters: readonly IllusionCounter[];
    duration: 'finite-boundary-expiry';
    lowerUse: string;
    interference: readonly string[];
    observation: string;
    persistence: string;
    replay: string;
    missingMechanismIds: readonly string[];
    plannedFixtureId: string;
  };
};

const illusionCurseDraftNodes = ILLUSION_CURSE_BRANCH_PLANS.flatMap((branch) =>
  branch.nodes.map((plan, index) => {
    const dan = (index + 1) as SkillDan,
      id = `skill.${ILLUSION_CURSE_PATH_ID}.${branch.zodiac}.${dan}`,
      cue = plan.modality !== 'none';
    return {
      node: {
        id,
        coordinate: { path: ILLUSION_CURSE_PATH_ID, zodiac: branch.zodiac, dan },
        name: plan.name,
        description: `${plan.behavior} Lower-dan use: ${plan.lowerUse}`,
        lifecycle: 'draft',
        prerequisites:
          dan === 1 ? [] : [`skill.${ILLUSION_CURSE_PATH_ID}.${branch.zodiac}.${dan - 1}`],
        deepening: {
          kind: DEEPENING_KINDS[index]!,
          explanation: plan.behavior,
          retainsLowerUse: true,
          ...(plan.conditionOrTradeoff ? { conditionOrTradeoff: plan.conditionOrTradeoff } : {}),
        },
        pathRoleTags: [
          `illusion-curse.${plan.technique}`,
          `zodiac.${branch.zodiac}`,
          ...(plan.modality === 'none' ? [] : [`modality.${plan.modality}`]),
        ],
        resolution: [],
        fixtureIds: [],
      },
      design: {
        branchRole: branch.role,
        technique: plan.technique,
        modality: plan.modality,
        target: plan.target,
        defense: plan.defense,
        counters: [...plan.counters],
        duration: 'finite-boundary-expiry',
        lowerUse: plan.lowerUse,
        interference: cue
          ? ['real-collision', 'target-validation', 'visibility', 'seal', 'cleanse']
          : ['status-stacking', 'seal', 'cleanse', 'simultaneous-application'],
        observation: cue
          ? 'Per-observer delivery may change subjective AI only; canonical truth and other observers remain unchanged.'
          : 'Public status summaries stay coarse and hidden values never enter enemy cognition.',
        persistence: cue
          ? 'A versioned cue feature must round-trip through API, worker, database and artifact validation.'
          : 'Reuse immutable status revisions and recorded status events after the new defense contract exists.',
        replay: cue
          ? 'Truth and affected-actor views reconstruct recorded cues through seek, reverse and loop without engine execution.'
          : 'Recorded status state reconstructs without engine execution; old omitted fields remain readable.',
        missingMechanismIds: mechanismIds(plan),
        plannedFixtureId: `fixture.skill.${ILLUSION_CURSE_PATH_ID}.${branch.zodiac}.${dan}`,
      },
    };
  }),
) satisfies IllusionCurseDraftNode[];

export const ILLUSION_CURSE_DRAFT_NODES = deepFreeze(illusionCurseDraftNodes);

export const ILLUSION_CURSE_ZODIAC_ORDER = SKILL_ZODIACS.map(({ id }) => id);
export const ILLUSION_CURSE_DAN_ORDER = SKILL_DANS.map(({ dan }) => dan);
