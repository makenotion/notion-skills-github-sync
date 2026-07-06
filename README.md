# notion-skills-github-sync

Sincroniza periódicamente páginas de habilidades desde una base de datos de Notion
hacia un repositorio de GitHub estructurado como un **marketplace de plugins de
Claude Code**. Una página de Notion se convierte en un plugin (que contiene una
habilidad); el archivo `.claude-plugin/marketplace.json` del repositorio se mantiene
sincronizado para que las habilidades sean instalables en Claude Cowork / Claude Code.

## Cómo se mapea

Cada página publicada en Notion →

```
plugins/<slug>/
  .claude-plugin/plugin.json                 # nombre, versión, descripción, autor
  skills/<slug>/
    SKILL.md                                  # frontmatter (descripción) + cuerpo de la página
    .notion-sync.json                         # referencia a la página de Notion
```

y una entrada en el archivo raíz `.claude-plugin/marketplace.json`.

> **Mantenedores y agentes de código:** consulta [`CLAUDE.md`](./CLAUDE.md) para
> los detalles específicos de este despliegue, el runbook de GitHub Actions, la
> rotación de secretos, el ciclo de validación y las advertencias.

- **slug** proviene del título `Skill name` (minúsculas, separado por guiones,
  deduplicado).
- **description** proviene de la propiedad `Description`; si está vacía, se
  deriva de la primera línea del cuerpo y se muestra una advertencia.
- **body** es el contenido de la página de Notion en formato Markdown.
- **`.notion-sync.json`** registra los IDs de `env` / base de datos / data-source /
  página de Notion y la URL de la página, además de un hash del contenido. Los
  clientes de Cowork lo usan para saber de dónde proviene una habilidad y para
  escribir cambios de vuelta. También marca el plugin como gestionado por esta
  herramienta, por lo que la limpieza nunca afecta plugins creados manualmente.

## Semántica de sincronización

- Solo se sincronizan las filas con la casilla **`Published`** marcada.
- **Notion es la fuente de verdad** — las ediciones manuales a archivos
  gestionados se sobrescriben en la siguiente sincronización.
- Las habilidades eliminadas/despublicadas en Notion se **eliminan** del
  repositorio (archivos + entrada del marketplace). Los plugins no gestionados
  creados manualmente se dejan intactos.
- **Idempotente** — una sincronización sin cambios reales no genera un commit
  (comparación de git-blob-sha), por lo que las ejecuciones programadas nunca
  producen commits vacíos.
- Cada sincronización es **un commit atómico** a través de la API Git Data de GitHub.

## Prerrequisitos

- [Bun](https://bun.sh) ≥ 1.2
- El CLI `ntn`, autenticado en el workspace de Notion que contiene tu base de
  datos (la herramienta lo ejecuta para las lecturas de Notion).
- Autenticación de GitHub: ya sea `gh auth login` (la herramienta recurre a
  `gh auth token`) o un `GITHUB_TOKEN` con acceso de escritura al repositorio
  destino.

## Configuración

```bash
bun install
cp config.json.example config.json  # completa todas las configuraciones
```

Toda la configuración no secreta se encuentra en `config.json`. Los secretos
(como `GITHUB_TOKEN`) van en `.env` o como variables de entorno.

> **Agentes de IA:** Si falta `config.json`, consulta [`AGENTS.md`](./AGENTS.md)
> para instrucciones sobre cómo configurarlo, incluyendo cómo crear nuevas bases
> de datos.

Agrega la puerta `Published` a la base de datos y verifica las filas existentes
(idempotente, re-ejecutable):

```bash
bun run setup
```

## Uso

```bash
bun run dry-run             # muestra qué cambiaría, no envía nada
bun run sync                # sincroniza a la rama configurada
bun run typecheck
bun test
```

**config.json** (ver `config.json.example`):

| Campo | Requerido | Predeterminado | Notas |
|---|---|---|---|
| `skillsDataSourceId` | Sí | — | ID del data source de habilidades |
| `githubRepo` | Sí | — | repositorio destino, `owner/name` |
| `notionEnv` | No | `prod` | entorno de `ntn` (`dev`/`stg`/`prod`) |
| `skillsDatabaseId` | No | — | usado por `setup` para agregar la propiedad |
| `changeRequestsDataSourceId` | No | — | habilita "proponer un cambio" en el actualizador |
| `githubBranch` | No | `main` | rama a sincronizar |
| `pluginsDir` | No | `plugins` | donde se generan los plugins |
| `authorName` / `authorEmail` | No | `notion-skills-sync` | info del autor del commit |

**Variables de entorno** (solo secretos — ver `.env.example`):

| Variable | Predeterminado | Notas |
|---|---|---|
| `GITHUB_TOKEN` | (recurre a `gh auth token`) | necesita acceso de escritura |

> Apunta `githubBranch` a una rama desechable primero para validar la salida,
> luego cámbialo a tu rama real.

## Ejecución en GitHub Actions

`.github/workflows/sync.yml` ejecuta la sincronización cada hora (y mediante el
botón manual **Run workflow**). Instala `ntn` en un runner estándar de Ubuntu
(`curl -fsSL https://ntn.dev | bash`), por lo que no se necesita un runner
self-hosted.

Agrega dos secretos al repositorio:

| Secreto | Qué es |
|---|---|
| `NOTION_API_TOKEN` | Token de la API de Notion (ntn lo lee del entorno, sobrescribiendo la autenticación del keychain) |
| `GH_PUSH_TOKEN` | PAT / token con granularidad fina con `contents:write` en el repositorio destino (el `GITHUB_TOKEN` predeterminado no puede hacer push a un repositorio *diferente*) |

La configuración no secreta (entorno, IDs de data-source/base de datos,
repositorio/rama destino) se establece en línea en el bloque `env:` del workflow
— edítalo ahí para retarget. Si alojas el workflow *dentro* del repositorio
destino, puedes eliminar el secreto push-token y usar el token integrado con
`permissions: contents: write`.

## Despliegue en Vercel (scaffolded)

`api/sync.ts` + `vercel.json` (cron cada hora) están incluidos. **Advertencia:**
el adaptador de Notion por defecto ejecuta `ntn` en un subproceso, el cual no
está disponible en el runtime de Vercel, y tu host de la API de Notion podría no
ser accesible desde el runtime serverless. Para ejecutar en Vercel:

1. Implementa un `NotionClient` directo vía REST (la interfaz en
   `src/notion/types.ts`) contra una API accesible e inyéctalo en `runSync`.
2. Configura `GITHUB_TOKEN`, las credenciales de Notion y `CRON_SECRET` como
   variables de entorno en Vercel.

La ruta de escritura a GitHub ya funciona en cualquier lugar (HTTPS plano + token).

## Arquitectura

```
src/
  cli.ts            comandos: setup | sync [--dry-run]
  config.ts         config.json -> Config
  setup.ts          agrega la propiedad Published + verifica filas
  sync.ts           orquestación: Notion -> plan -> commit en GitHub
  plan.ts           puro: conjunto de archivos deseados, conjunto de limpieza, merge del marketplace (testeado)
  convert.ts        puro: página -> SKILL.md / plugin.json / marcador (testeado)
  diff.ts           puro: comparación de git-blob-sha / idempotencia (testeado)
  slugify.ts        puro: nombre -> slug único (testeado)
  github.ts         cliente de la API Git Data de GitHub
  notion/
    types.ts        interfaz NotionClient (punto de intercambio para REST/Vercel)
    ntn.ts          invocación de bajo nivel de `ntn`
    ntn-adapter.ts  NotionClient respaldado por el CLI `ntn`
api/sync.ts         handler de Vercel (ver advertencia arriba)
.github/workflows/sync.yml   sincronización horaria con GitHub Actions (instala ntn)
```

Los módulos puros contienen toda la lógica de conversión/diff y están testeados
unitariamente; las capas de red (`ntn`, GitHub) son delgadas e intercambiables.
