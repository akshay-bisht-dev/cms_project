'use client';

// Rendered when the root layout itself fails, so it cannot rely on the layout's styles.
export default function GlobalError({ reset }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: '4rem 1rem', maxWidth: 480, margin: '0 auto' }}>
        <h1>Something went wrong</h1>
        <p>Orbit failed to load. Please try again.</p>
        <button type="button" onClick={() => reset()}>Try again</button>
      </body>
    </html>
  );
}
