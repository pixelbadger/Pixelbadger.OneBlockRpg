# The Pier: story brief

The first example story (spec Q22). It is the test fixture and the worked example for the authoring guide (§7.9).
This is the human's input to the coding agent that builds the payload (§7.2). The sections follow §7.2.

## Premise & tone

A ghost story set on and around a seaside pier, based on **Clevedon Pier and its glass house**. The block is the pier,
the hotel next to it, and the seafront around them.

- **Present day** throughout (decided). The Victorian past exists only as apparitions, Perception-gated text and set pieces. There is no
  second traversable time layer.
- The tone is quiet and accumulating, then unbearable. Mundane labouring life on a building site, with the uncanny
  seeping in.

## General plot

The player is a **young, disaffected man labouring on a hotel renovation** next to the pier. He keeps seeing a
**ghostly Victorian couple**.

The couple's story, which the player uncovers piece by piece:

1. The couple had a **stillborn child**. The woman hid this from her husband.
2. They went on holiday to the pier.
3. The child was revealed to be dead. The husband went mad and **burned down the glass house** with himself, his wife and
   the child inside.

As the player uncovers this, he goes mad too.

## Characters

| Character | Notes |
|---|---|
| The player | Young, disaffected labourer on the hotel renovation. |
| The Victorian husband | Ghost. Goes mad on learning the truth and sets the fire. |
| The Victorian wife | Ghost. Hid the stillbirth from her husband. |
| The child | Stillborn. Present in the story, not as a character. |
| Other labourers | Several, on the same site. |
| Site foreman | Runs the renovation. |
| Two friends at a pub | The player's social life off-site. |

Names, personalities, SPECIAL and routines are left to the authoring agent.

### The ghosts (decided)

- **Silent and seen only.** The couple never speak to the player and have no conversation specs. Their story reaches him
  through objects, archives, locals' talk and set pieces.
- They appear and disappear through triggers (`spawn` / `move` / `remove`), and only the player perceives them. See open question Q31.

## Madness (decided)

Madness is not a new stat (SPECIAL is the only system). It is expressed as:

- **Authored stage flags** set by discovery triggers, e.g. `unease` → `obsession` → `breakdown`. They change text, options and how
  other characters react to him.
- **Timed `modify` effects on SPECIAL**, e.g. Perception up (he sees more), Charisma and Intelligence down.

## Relationships & tensions

The player is alienated from the work and the people around him. The foreman, the other labourers and his pub friends
notice him changing as the madness stages advance.

## Trigger points

**Discovery-paced, with a deadline** (decided). Each piece of the couple's story the player uncovers advances the
madness. A final day forces the ending if the player stalls.

## Set pieces

- **The final burning.** The player recreates the fire in the glass house. Inside it, he sees the couple quietly drinking tea as
  the flames consume them all, across both time periods.

Earlier apparition set pieces are left to the authoring agent.

## Endings

**One ending, and it is inevitable.** The player goes mad and recreates the burning. The player's agency is in how and how much
he understands before it happens, not in whether it happens.
