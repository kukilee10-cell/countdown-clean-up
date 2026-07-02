import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Journey Home — Work today. Home tomorrow." },
      { name: "description", content: "Journey Home — the premium countdown app for FIFO workers. Work today. Home tomorrow." },
      { property: "og:title", content: "Journey Home" },
      { property: "og:description", content: "Work today. Home tomorrow. The premium countdown for FIFO workers." },
    ],
  }),
  component: Index,
});

function Index() {
  // The full Journey Home app is a static site under /public/fifo/.
  // Serve it here via an iframe so the Lovable published URL shows the real app.
  return (
    <iframe
      src="/fifo/index.html"
      title="Journey Home"
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        border: "none",
      }}
    />
  );
}
