/**
 * The first-launch offer: "FIRST TIME HERE?".
 *
 * Built from the approved mock `mocks/screen-tutorial-offer-v1`, with one recorded correction: the mock
 * shows the dialog over a run that is already twelve seconds old with skeletons closing in. Wrong. The
 * offer appears the instant the first run starts, before anything can reach the player. Being asked
 * whether you would like to be taught while something is already eating you is not an offer.
 *
 * Everything else about it is deliberate:
 *
 *  - Two answers, both plain, neither pre-selected and neither permanent. "SHOW ME HOW" is the gold
 *    button because it is the thing the screen exists to offer; "I'VE GOT IT" is stone, not grey, because
 *    it is a real answer and not a way out.
 *  - The footnote says where to find this again. A one-time dialog with no forwarding address is a dialog
 *    people are afraid to dismiss.
 *  - No close button and no way to answer by tapping the background. Two buttons, one tap, done. A
 *    dismissable version of this question would have to be asked again, and it is asked once.
 *  - The run behind it is visible and is genuinely running. It does not dim the whole screen, because the
 *    polish bar is "must feel expensive" and a grey wash over the game is the cheapest thing in games.
 *
 * The words are string ids, not sentences. Every line in the guide is numbered from day one so a
 * translator can be handed a list rather than sent hunting through the code.
 */

import { View, StyleSheet } from "react-native";
import { Palette, Grid } from "@/constants/theme";
import { Chunk, Slab, StoneText } from "@/components/stone";
import { EN, STR, text } from "@/game/guide/strings";
import { OFFER_ANSWER, type OfferAnswer } from "@/game/guide/arming";

export function GuideOffer({
  onAnswer,
  table = EN,
}: {
  /** Called once with the player's answer. The caller writes it down and takes this off screen. */
  onAnswer: (answer: OfferAnswer) => void;
  /** The string table. Passed in so pseudo-localization can be previewed without a rebuild. */
  table?: readonly string[];
}): React.ReactNode {
  return (
    // `box-none` so the panel takes touches and the run behind it keeps taking them everywhere else. A
    // full-screen touch blocker would freeze the player in place while they read.
    <View style={styles.layer} pointerEvents="box-none">
      <Slab style={styles.panel}>
        <StoneText tone="bone" size={22} bold align="center">
          {text(STR.offerTitle, table)}
        </StoneText>

        <View style={styles.body}>
          <StoneText tone="bone" size={12} align="center">
            {text(STR.offerBodyOne, table)}
          </StoneText>
          <StoneText tone="bone" size={12} align="center">
            {text(STR.offerBodyTwo, table)}
          </StoneText>
        </View>

        <Chunk
          label={text(STR.offerYes, table)}
          weight="gold"
          style={styles.button}
          onPress={() => onAnswer(OFFER_ANSWER.SHOW_ME)}
        />
        <Chunk
          label={text(STR.offerNo, table)}
          weight="stone"
          style={styles.button}
          onPress={() => onAnswer(OFFER_ANSWER.GOT_IT)}
        />

        <StoneText tone="ash" size={10} align="center" style={styles.footnote}>
          {text(STR.offerFootnote, table)}
        </StoneText>
      </Slab>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Grid * 3,
  },
  panel: {
    width: "100%",
    maxWidth: 420,
    paddingVertical: Grid * 3,
    paddingHorizontal: Grid * 3,
    gap: Grid * 1.5,
    backgroundColor: Palette.ink,
  },
  body: {
    gap: 2,
    marginBottom: Grid,
  },
  button: {
    width: "100%",
  },
  footnote: {
    marginTop: Grid / 2,
  },
});
