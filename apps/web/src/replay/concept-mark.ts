/** Shared 2D/3D decoration for recorded capabilities. */
export function conceptMark(actor: {
  frozen: boolean;
  evaded: boolean;
  protected: boolean;
  defeated: boolean;
  revived: boolean;
}) {
  return actor.frozen
    ? { colour: '#7bc9ff', label: '時間停止中' }
    : actor.evaded
      ? { colour: '#88ffff', label: '接触回避' }
      : actor.protected
        ? { colour: '#ffdf72', label: '不死の保護' }
        : actor.defeated
          ? { colour: '#f75570', label: '即死の成立' }
          : actor.revived
            ? { colour: '#72e0c1', label: '蘇生' }
            : { colour: '#d9a6ff', label: '封印中' };
}
