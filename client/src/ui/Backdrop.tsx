import { useTheme } from '../theme/theme';

/** The page background: the theme colour, or the user's picture with dim and blur. */
export function Backdrop() {
  const { theme, imageUrl } = useTheme();
  const show = theme.image && theme.bgPicture && imageUrl;
  return (
    <div className="backdrop" aria-hidden>
      {show && <div className="backdrop-img" style={{ backgroundImage: `url("${imageUrl}")` }} />}
      {show && <div className="backdrop-dim" />}
    </div>
  );
}
