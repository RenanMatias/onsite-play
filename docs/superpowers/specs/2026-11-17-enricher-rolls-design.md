# Links de journal (enrichers) no Onsite Play — design

Versão alvo: **1.0.2**.

## Intenção

Na mesa, o GM lê um journal e clica em links como `[[/skill athletics 12]]` ("Atletismo CD 12") ou `[[/damage 2d6 fire]]`. Hoje:

- **Teste com token de PC selecionado:** já funciona. O dnd5e chama `actor.rollSkill`, e o diálogo de total + Natural 20/1 do módulo abre.
- **Teste sem token selecionado** (caso normal do GM): o dnd5e mostra "nenhum ator" e nada acontece.
- **Dano ou cura solta** (sem atividade): o dnd5e rola os dados digitalmente e posta um cartão de dano.

O objetivo é que esses links também usem os dados físicos: o GM escolhe quem faz o teste ou recebe o dano e digita os totais rolados na mesa.

## Objetivos

- Testes de atributo, perícia, ferramenta, salvaguarda e concentração via link, sem token selecionado: um diálogo com **todos os atores do tipo `character`**, cada um com campo de total + Natural 20/1. Quem fica em branco não faz o teste.
- `[[/damage]]` e `[[/heal]]` soltos: o dano/cura é digitado **uma vez para todos**, por tipo, sem Natural 20/1, e aplicado a cada personagem escolhido com as regras do dnd5e. Gera um cartão de resumo com Undo.

## Fora do escopo

- Links "request" (`request=true`): já postam um cartão com botões que passam pelo módulo.
- `[[/attack]]` e `[[/damage]]` ligados a uma atividade: já passam pelos fluxos existentes.
- Dano diferente por personagem e salvaguarda automática ligada ao dano: cada link é independente.

## Abordagens

1. **Híbrida (escolhida):** dano/cura pelo hook `dnd5e.preRollDamageV2` quando não há `subject`, e testes por um listener de clique em fase de captura, ativo só quando não há token selecionado nem personagem atribuído. Usa a API pública onde ela existe e restringe a parte frágil (o HTML do link) ao caso que não tem hook.
2. **Só clique:** um listener lê os `data-*` do link para tudo. É um mecanismo só, mas depende inteiramente do HTML e não cobre o comando `/damage` do chat.
3. **Substituir `rollCheckSave`:** é interno do dnd5e, não é possível substituir.

## Comportamento

### Testes (sem token selecionado)

- O listener de captura no `document` reage a cliques em links de teste do dnd5e (`check`, `skill`, `tool`, `save`, `concentration`, exceto `request`). Só intervém se o módulo estiver ativo, a opção **Manual checks and saves** estiver ligada, houver GM ativo, nenhum token controlado e o usuário não tiver personagem atribuído. Nos demais casos, o dnd5e segue normalmente e cai no diálogo atual.
- Ao intervir, cancela o clique e abre um diálogo, no estilo do "Roll All" da iniciativa, com o nome do teste e a CD (se houver), e uma linha por ator `character` (retrato, nome, bônus do teste quando for fácil de calcular, total, Normal / 20 natural / 1 natural). Para confirmar, é preciso ao menos uma linha preenchida.
- Para cada linha preenchida, chama o método do dnd5e (`rollSkill`, `rollToolCheck`, `rollAbilityCheck`, `rollSavingThrow`, `rollConcentration`) com a CD e o resultado já digitado na config (`{ "onsite-play": { result: { total, nat } } }`). `ManualRollConfiguration` usa esse resultado em vez de abrir o diálogo. O dnd5e continua postando o cartão e aplicando o resultado.
- Se quem clica é um jogador nessa situação, o pedido vai ao GM por query.

### Dano / cura solta

- Em `dnd5e.preRollDamageV2` sem `config.subject` (link solto, ou o comando `/damage` no chat), com o módulo ativo e um GM ativo: cancela a rolagem e abre o fluxo. Os tipos vêm de `config.rolls[].options.types`, e as fórmulas aparecem como dica.
- Destinatários: os tokens selecionados, se houver. Se não houver, o diálogo lista todos os atores `character` com caixas de seleção, e é preciso marcar pelo menos um.
- Um único diálogo traz um campo de valor por parte/tipo (com escolha quando há vários tipos), a opção "Ignorar resistências/imunidades" e, se for o caso, a lista de PCs. Não tem Natural 20/1.
- A aplicação usa `applyDamageToTarget` / a cura existente (PV temporários, resistências, 0 PV), com um cartão de resumo e Undo. Um PC sem token na cena recebe o dano no ator. Se tiver um token ativo na cena, recebe no token.
- Se quem clica é um jogador, o pedido vai ao GM por query.

## Decisões minhas (para revisar)

- Nenhuma configuração nova: os testes respeitam **Manual checks and saves**, e o dano respeita **Enable Onsite Play**.
- Para o dano, "selecionado" significa tokens controlados, e não alvos (T).
- O comando `/damage` digitado no chat também passa a usar o fluxo, por coerência.
- Seleção e totais ficam num só diálogo, em vez de "escolher PCs" e depois "digitar totais".

## Fica para quem implementa

- O seletor exato dos links de teste no HTML do dnd5e (a verificar no fonte instalado) e o título do cartão de resumo sem atividade.
- O cálculo do bônus mostrado na linha (opcional) e o ajuste de `postSummary` / `TargetInfo` para funcionar sem atividade e sem token.
- README (seção nova e limitações), CHANGELOG 1.0.2, chaves novas em `en.json` e `pt-BR.json`, `version`/`download` em `module.json`.
