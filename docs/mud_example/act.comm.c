#include "spec_procs.h"
#include "ai_service.h"
#include "quest.h"
#include "discord_bridge.h"

ACMDU(do_rsay)
{


@@ -979,6 +980,9 @@ ACMDU(do_gen_comm)
    send_to_char(i->character, "%s%s%s", (COLOR_LEV(i->character) >= C_NRM) ? color_on : "", buf3, KNRM);
    
  }
  
  /* Send to Discord bridge if enabled */
  route_mud_to_discord(subcmd, ch, argument, emoting);
}

ACMDU(do_qcomm)

