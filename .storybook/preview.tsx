import type { Preview } from "@storybook/react";
import "../src/caliber-ui/styles/tokens.css";

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: "app",
      values: [{ name: "app", value: "var(--bg-app)" }],
    },
  },
  decorators: [
    (Story) => (
      <div style={{ background: "var(--bg-app)", font: "var(--type-body)", minHeight: "100vh", padding: 24 }}>
        <Story />
      </div>
    ),
  ],
};

export default preview;
