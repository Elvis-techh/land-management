interface PlaceholderPageProps {
  title: string;
}

/**
 * Stand-in for the screens that have not been built yet. Each one gets its own
 * real component as we build it, feature by feature, all the way down to the
 * database. The frozen prototype in docs/prototype/index.html still shows what
 * these screens are meant to look like.
 */
export function PlaceholderPage({ title }: PlaceholderPageProps) {
  return (
    <section className="panel active">
      <div className="card">
        <div className="card-head">
          <h3>{title}</h3>
          <span className="tag">pendiente</span>
        </div>
        <p style={{ padding: "18px 0 4px", color: "var(--text-secondary)", lineHeight: 1.6 }}>
          Esta pantalla todavía no está construida. La pantalla de <strong>Lotes</strong> ya
          funciona en React y es el modelo a seguir para las demás.
        </p>
      </div>
    </section>
  );
}
