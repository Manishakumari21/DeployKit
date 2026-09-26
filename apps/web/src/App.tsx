import { useEffect, useState } from "react";

type Project = {
  id: string;
  name: string;
  repository_url: string;
  branch: string;
};

const API_URL = "http://localhost:3000/api";

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadProjects() {
    const response = await fetch(`${API_URL}/projects`);
    const data = await response.json();
    setProjects(data);
  }

  useEffect(() => {
    loadProjects();
  }, []);

  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          repositoryUrl,
          branch,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to create project");
      }

      setName("");
      setRepositoryUrl("");
      setBranch("main");

      await loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function deleteProject(id: string) {
    await fetch(`${API_URL}/projects/${id}`, {
      method: "DELETE",
    });

    await loadProjects();
  }

  return (
    <main style={{
      maxWidth: "1000px",
      margin: "0 auto",
      padding: "40px 24px",
      fontFamily: "system-ui",
    }}>
      <header>
        <h1>DeployKit</h1>
        <p>Self-hosted application deployment platform</p>
      </header>

      <section>
        <h2>Create Project</h2>

        <form onSubmit={createProject}>
          <input
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          <input
            placeholder="GitHub repository URL"
            value={repositoryUrl}
            onChange={(e) => setRepositoryUrl(e.target.value)}
          />

          <input
            placeholder="Branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />

          <button disabled={loading}>
            {loading ? "Creating..." : "Create Project"}
          </button>
        </form>

        {error && <p>{error}</p>}
      </section>

      <section>
        <h2>Projects</h2>

        {projects.length === 0 ? (
          <p>No projects yet.</p>
        ) : (
          projects.map((project) => (
            <article key={project.id}>
              <h3>{project.name}</h3>

              <p>{project.repository_url}</p>

              <p>Branch: {project.branch}</p>

              <button onClick={() => deleteProject(project.id)}>
                Delete
              </button>
            </article>
          ))
        )}
      </section>
    </main>
  );
}

export default App;