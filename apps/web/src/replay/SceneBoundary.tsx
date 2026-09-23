import { Component, type ReactNode } from 'react';
export class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <p role="status" aria-label="描画状態">
        3D表示を利用できません。状態表と保存ログは引き続き確認できます。
      </p>
    ) : (
      this.props.children
    );
  }
}
