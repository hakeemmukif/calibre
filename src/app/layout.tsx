import "@/caliber-ui/styles/tokens.css";
import { PostHogInit } from "@/features/analytics/PostHogInit";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PostHogInit />
        {children}
      </body>
    </html>
  );
}
