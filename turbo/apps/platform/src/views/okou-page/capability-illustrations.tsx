import type { ReactNode } from "react";
import { cn } from "@okouai/ui";

/**
 * The capability cards' line drawings, coloured from tokens so they follow the
 * theme. Each drawing is cropped to its subject and sized to one shared area,
 * then centred in its card's drawing box, which stays clear of the copy and
 * the buttons; so every card's drawing reads at the same size.
 *
 * Motion runs once per hover, on one 1.2s timeline for every drawing: each
 * element's delay plus duration ends by 1.2s, and every keyframe ends on the
 * resting drawing, so nothing jumps when the pointer leaves.
 */
export type CapabilityArt =
  | "people"
  | "research"
  | "presentation"
  | "image"
  | "document"
  | "website"
  | "chart"
  | "scheduled"
  | "triggers"
  | "advanced";

const ARTS = {
  people: {
    viewBox: "205 120 386 303",
    frame: "h-[105px] w-[134px] right-[61px] top-[31.5px]",
    drawing: (
      <>
        <g>
          <g>
            <path
              d="M277 325V374H371M399 282V315L407 332M519 348V374H457"
              strokeWidth={1.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M277 328C278.657 328 280 326.657 280 325C280 323.343 278.657 322 277 322C275.343 322 274 323.343 274 325C274 326.657 275.343 328 277 328Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <path
              d="M519 351C520.657 351 522 349.657 522 348C522 346.343 520.657 345 519 345C517.343 345 516 346.343 516 348C516 349.657 517.343 351 519 351Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
          </g>
          <g>
            <path
              d="M331 169H223C216.373 169 211 174.373 211 181V313C211 319.627 216.373 325 223 325H331C337.627 325 343 319.627 343 313V181C343 174.373 337.627 169 331 169Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <g>
              <path
                d="M277 258C294.673 258 309 243.673 309 226C309 208.327 294.673 194 277 194C259.327 194 245 208.327 245 226C245 243.673 259.327 258 277 258Z"
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
              <path
                d="M277 227C282.523 227 287 222.523 287 217C287 211.477 282.523 207 277 207C271.477 207 267 211.477 267 217C267 222.523 271.477 227 277 227Z"
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
                className="fill-gray-200 stroke-gray-500/55 motion-safe:group-hover/card:animate-capability-lit motion-safe:group-focus-within/card:animate-capability-lit [--capability-delay:200ms]"
              />
              <path
                d="M253 247C256 234 266 231 277 231C288 231 298 234 301 247C288 261 266 261 253 247Z"
                strokeWidth={1.2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className="fill-gray-200 stroke-gray-500/55 motion-safe:group-hover/card:animate-capability-lit motion-safe:group-focus-within/card:animate-capability-lit [--capability-delay:200ms]"
              />
            </g>
            <path
              d="M249 281H305M260 291H294"
              strokeWidth={1.2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g>
            <path
              d="M453 126H345C338.373 126 333 131.373 333 138V270C333 276.627 338.373 282 345 282H453C459.627 282 465 276.627 465 270V138C465 131.373 459.627 126 453 126Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <g>
              <path
                d="M399 215C416.673 215 431 200.673 431 183C431 165.327 416.673 151 399 151C381.327 151 367 165.327 367 183C367 200.673 381.327 215 399 215Z"
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
              <path
                d="M399 184C404.523 184 409 179.523 409 174C409 168.477 404.523 164 399 164C393.477 164 389 168.477 389 174C389 179.523 393.477 184 399 184Z"
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
                className="fill-gray-200 stroke-gray-500/55 motion-safe:group-hover/card:animate-capability-lit motion-safe:group-focus-within/card:animate-capability-lit [--capability-delay:400ms]"
              />
              <path
                d="M375 204C378 191 388 188 399 188C410 188 420 191 423 204C410 218 388 218 375 204Z"
                strokeWidth={1.2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className="fill-gray-200 stroke-gray-500/55 motion-safe:group-hover/card:animate-capability-lit motion-safe:group-focus-within/card:animate-capability-lit [--capability-delay:400ms]"
              />
            </g>
            <path
              d="M371 238H427M382 248H416"
              strokeWidth={1.2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M448 147C450.209 147 452 145.209 452 143C452 140.791 450.209 139 448 139C445.791 139 444 140.791 444 143C444 145.209 445.791 147 448 147Z"
              className="fill-primary"
            />
          </g>
          <g>
            <path
              d="M573 192H465C458.373 192 453 197.373 453 204V336C453 342.627 458.373 348 465 348H573C579.627 348 585 342.627 585 336V204C585 197.373 579.627 192 573 192Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <g>
              <path
                d="M519 281C536.673 281 551 266.673 551 249C551 231.327 536.673 217 519 217C501.327 217 487 231.327 487 249C487 266.673 501.327 281 519 281Z"
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
              <path
                d="M519 250C524.523 250 529 245.523 529 240C529 234.477 524.523 230 519 230C513.477 230 509 234.477 509 240C509 245.523 513.477 250 519 250Z"
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
                className="fill-gray-200 stroke-gray-500/55 motion-safe:group-hover/card:animate-capability-lit motion-safe:group-focus-within/card:animate-capability-lit [--capability-delay:600ms]"
              />
              <path
                d="M495 270C498 257 508 254 519 254C530 254 540 257 543 270C530 284 508 284 495 270Z"
                strokeWidth={1.2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className="fill-gray-200 stroke-gray-500/55 motion-safe:group-hover/card:animate-capability-lit motion-safe:group-focus-within/card:animate-capability-lit [--capability-delay:600ms]"
              />
            </g>
            <path
              d="M491 304H547M502 314H536"
              strokeWidth={1.2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g className="transform-fill origin-center motion-safe:group-hover/card:animate-capability-pulse motion-safe:group-focus-within/card:animate-capability-pulse">
            <path
              d="M414 417C437.748 417 457 397.748 457 374C457 350.252 437.748 331 414 331C390.252 331 371 350.252 371 374C371 397.748 390.252 417 414 417Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <g>
              <path
                d="M409 382C416.18 382 422 376.18 422 369C422 361.82 416.18 356 409 356C401.82 356 396 361.82 396 369C396 376.18 401.82 382 409 382Z"
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
              <path
                d="M418.2 378.2L432 392"
                strokeWidth={1.2}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
            </g>
          </g>
        </g>
        <path
          d="M277 325V374H371M399 282V315L407 332M519 348V374H457"
          pathLength={1}
          strokeWidth={6}
          strokeLinecap="round"
          className="fill-none stroke-primary opacity-0 [stroke-dasharray:0.22_1.5] [stroke-dashoffset:0.22] motion-safe:group-hover/card:animate-capability-run motion-safe:group-focus-within/card:animate-capability-run"
        />
      </>
    ),
  },
  research: {
    viewBox: "204 131 436.7 308",
    frame: "h-[99px] w-[141px] right-[57.5px] top-[34.5px]",
    drawing: (
      <>
        <g>
          <g>
            <path
              d="M210 197L448 180L465 416L227 433L210 197Z"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <path
              d="M219 184L457 176L465 413L227 421L219 184Z"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <path
              d="M229 169H467V405H229V169Z"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <path
              d="M251 197H325M251 210H305M251 239H422M251 253H426M251 267H407M251 281H421M251 311H427M251 325H405M251 339H422M251 353H364"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M251 377H282M414 377H444"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g className="transform-view motion-safe:group-hover/card:animate-capability-scan motion-safe:group-focus-within/card:animate-capability-scan">
            <path
              d="M539 326L550 315L570 335L559 346L539 326Z"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <path
              d="M554 346L570 330L632 392C634.667 394.667 634.667 397.333 632 400L624 408C621.333 410.667 618.667 410.667 616 408L554 346Z"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <path
              d="M563 345L621 403"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g className="transform-view motion-safe:group-hover/card:animate-capability-scan motion-safe:group-focus-within/card:animate-capability-scan">
            <path
              d="M469 353C528.647 353 577 304.647 577 245C577 185.353 528.647 137 469 137C409.353 137 361 185.353 361 245C361 304.647 409.353 353 469 353Z"
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <path
              d="M469 345C524.228 345 569 300.228 569 245C569 189.772 524.228 145 469 145C413.772 145 369 189.772 369 245C369 300.228 413.772 345 469 345Z"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <g className="transform-view motion-safe:group-hover/card:animate-capability-scan motion-safe:group-focus-within/card:animate-capability-scan">
              <path
                d="M414 190H504M398 211H535M390 232H526"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
              <path
                d="M527 247H391C389.895 247 389 247.895 389 249V259C389 260.105 389.895 261 391 261H527C528.105 261 529 260.105 529 259V249C529 247.895 528.105 247 527 247Z"
                className="fill-brand-subtle transform-fill origin-left motion-safe:group-hover/card:animate-capability-sweep motion-safe:group-focus-within/card:animate-capability-sweep [--capability-delay:400ms]"
              />
              <path
                d="M394 254H521M390 276H546M401 297H532M419 318H502"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
              <path
                d="M538 245V253M534.5 247L541.5 251M534.5 251L541.5 247"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-primary"
              />
            </g>
            <path
              d="M469 137V143M469 347V353M361 245H367M571 245H577"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
        </g>
      </>
    ),
  },
  presentation: {
    viewBox: "158 120 474 334",
    frame: "h-[99px] w-[141px] right-[45.5px] top-[14.5px]",
    drawing: (
      <>
        <g>
          <g className="transform-fill origin-bottom-left motion-safe:group-hover/card:animate-capability-fan-a motion-safe:group-focus-within/card:animate-capability-fan-a">
            <path
              d="M280 126L626 214L573 421L227 333L280 126Z"
              strokeWidth={1.2}
              strokeLinejoin="round"
              strokeDasharray="6 5"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g className="transform-fill origin-bottom-left motion-safe:group-hover/card:animate-capability-fan-b motion-safe:group-focus-within/card:animate-capability-fan-b">
            <path
              d="M238 149L594 211L558 419L202 357L238 149Z"
              strokeWidth={1.2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
          </g>
          <g>
            <path
              d="M203 187L565 215L549 427L187 399L203 187Z"
              strokeWidth={1.2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
          </g>
          <g>
            <path
              d="M164 239L519 212L535 421L180 448L164 239Z"
              strokeWidth={1.2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <g>
              <path
                d="M197 266L287 259M198 276L249 272"
                strokeWidth={1.2}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
              <path
                d="M199 291L491 269"
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-400/80"
              />
              <path
                d="M202 318L264 313M203 329L277 323M204 340L251 336M207 376L260 372M208 387L247 384"
                strokeWidth={1.2}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
              <path
                d="M291 308L298 398"
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-400/80"
              />
            </g>
            <g>
              <path
                d="M319 326L480 314M321 352L482 340"
                strokeWidth={0.8}
                strokeDasharray="3 4"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-400/80"
              />
              <path
                d="M337 352L360 350L363 389L340 391L337 352Z"
                strokeWidth={1.2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className="fill-gray-200 stroke-gray-500/55 transform-fill origin-bottom motion-safe:group-hover/card:animate-capability-grow motion-safe:group-focus-within/card:animate-capability-grow [--capability-delay:200ms]"
              />
              <path
                d="M379 333L402 331L406 386L383 387L379 333Z"
                strokeWidth={1.2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className="fill-gray-200 stroke-gray-500/55 transform-fill origin-bottom motion-safe:group-hover/card:animate-capability-grow motion-safe:group-focus-within/card:animate-capability-grow [--capability-delay:350ms]"
              />
              <path
                d="M421 302L444 300L450 382L427 384L421 302Z"
                strokeWidth={1.2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className="fill-primary stroke-primary transform-fill origin-bottom motion-safe:group-hover/card:animate-capability-grow motion-safe:group-focus-within/card:animate-capability-grow [--capability-delay:500ms]"
              />
              <path
                d="M317 305L324 392L484 380"
                strokeWidth={1.2}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
            </g>
          </g>
        </g>
      </>
    ),
  },
  image: {
    viewBox: "197 105.8 415 330.2",
    frame: "h-[104px] w-[131px] right-[50.5px] top-[12px]",
    drawing: (
      <>
        <g>
          <g>
            <path
              d="M605.999 155.296L331.422 111.807L292.001 360.704L566.578 404.193L605.999 155.296Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <path
              d="M587.694 168.596L344.722 130.113L313.592 326.663L556.563 365.146L587.694 168.596Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M321.101 279.254L403.223 208.226L442.967 264.132L502.783 199.696L564.854 312.798L556.563 365.146L313.592 326.663L321.101 279.254Z"
              strokeWidth={1.2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-gray-200 stroke-gray-500/55"
            />
            <path
              d="M474.747 229.679L496.213 241.179L511.399 228.397M385.592 223.658L398.168 233.75L414.029 223.1"
              strokeWidth={1.2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g className="transform-fill origin-center motion-safe:group-hover/card:animate-capability-tilt motion-safe:group-focus-within/card:animate-capability-tilt">
            <path
              d="M527 194H203V430H527V194Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <path
              d="M510 211H220V392H510V211Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <g>
              <path
                d="M447 267C456.389 267 464 259.389 464 250C464 240.611 456.389 233 447 233C437.611 233 430 240.611 430 250C430 259.389 437.611 267 447 267Z"
                className="fill-primary transform-fill motion-safe:group-hover/card:animate-capability-sun motion-safe:group-focus-within/card:animate-capability-sun [--capability-delay:200ms]"
              />
            </g>
            <g>
              <path
                d="M220 357L309 260L394 354L454 292L510 351V392H220V357Z"
                strokeWidth={1.2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className="fill-gray-200 stroke-gray-500/55"
              />
              <path
                d="M285 286L300 283L312 297L325 278M436 311L451 317L465 305"
                strokeWidth={1.2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
              <path
                d="M220 375L271 348L333 371L377 338L437 368L478 351L510 367V392H220V375Z"
                strokeWidth={1.2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className="fill-gray-200 stroke-gray-500/55"
              />
            </g>
          </g>
        </g>
      </>
    ),
  },
  document: {
    viewBox: "240 124 280 331",
    frame: "h-[104px] w-[88px] right-[72px] top-[12px]",
    drawing: (
      <>
        <g>
          <g>
            <path
              d="M246 151H446L490 195V449H246V151Z"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <path
              d="M258 184V428H470"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g>
            <path
              d="M270 130H470L514 174V430H270V130Z"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <path
              d="M470 130V174H514L470 130Z"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-gray-200 stroke-gray-500/55"
            />
            <g>
              <path
                d="M302 190H409M302 207H365"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
            </g>
            <g>
              <path
                d="M477 278H299C298.448 278 298 278.448 298 279V293C298 293.552 298.448 294 299 294H477C477.552 294 478 293.552 478 293V279C478 278.448 477.552 278 477 278Z"
                className="fill-brand-subtle transform-fill origin-left motion-safe:group-hover/card:animate-capability-sweep motion-safe:group-focus-within/card:animate-capability-sweep [--capability-duration:600ms] [--capability-delay:600ms]"
              />
              <path
                d="M289 282V290"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-primary"
              />
            </g>
            <g>
              <path
                d="M302 244H478M302 265H478M302 286H463M302 307H478M302 328H434M302 365H478M302 386H450"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                pathLength={1}
                className="fill-none stroke-gray-500/55 [stroke-dasharray:1_1] motion-safe:group-hover/card:animate-capability-draw motion-safe:group-focus-within/card:animate-capability-draw"
              />
            </g>
          </g>
        </g>
      </>
    ),
  },
  website: {
    viewBox: "144 114 512 332",
    frame: "h-[95px] w-[147px] right-[42.5px] top-[16.5px]",
    drawing: (
      <>
        <g>
          <g>
            <path
              d="M644 120H156C152.686 120 150 122.686 150 126V434C150 437.314 152.686 440 156 440H644C647.314 440 650 437.314 650 434V126C650 122.686 647.314 120 644 120Z"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M156 120H644C648 120 650 122 650 126V160H150V126C150 122 152 120 156 120Z"
              vectorEffect="non-scaling-stroke"
              className="fill-gray-200 stroke-gray-500/55"
            />
          </g>
          <g>
            <path
              d="M170 143C171.657 143 173 141.657 173 140C173 138.343 171.657 137 170 137C168.343 137 167 138.343 167 140C167 141.657 168.343 143 170 143Z"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M183 143C184.657 143 186 141.657 186 140C186 138.343 184.657 137 183 137C181.343 137 180 138.343 180 140C180 141.657 181.343 143 183 143Z"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M196 143C197.657 143 199 141.657 199 140C199 138.343 197.657 137 196 137C194.343 137 193 138.343 193 140C193 141.657 194.343 143 196 143Z"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M565 131H233C231.343 131 230 132.343 230 134V146C230 147.657 231.343 149 233 149H565C566.657 149 568 147.657 568 146V134C568 132.343 566.657 131 565 131Z"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M614 136H630M614 140H630M614 144H630"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g className="transform-fill motion-safe:group-hover/card:animate-capability-rise motion-safe:group-focus-within/card:animate-capability-rise">
            <path
              d="M620 184H180V300H620V184Z"
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <path
              d="M202 208H382M202 223H344M202 240H402"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M264 260H204C202.895 260 202 260.895 202 262V278C202 279.105 202.895 280 204 280H264C265.105 280 266 279.105 266 278V262C266 260.895 265.105 260 264 260Z"
              vectorEffect="non-scaling-stroke"
              className="fill-primary stroke-primary"
            />
            <path
              d="M600 204H464V280H600V204Z"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M464 204L600 280M600 204L464 280"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g className="transform-fill motion-safe:group-hover/card:animate-capability-rise motion-safe:group-focus-within/card:animate-capability-rise [--capability-delay:150ms]">
            <path
              d="M312 322H180V366H312V322Z"
              vectorEffect="non-scaling-stroke"
              className="fill-gray-200 stroke-gray-500/55"
            />
            <path
              d="M180 383H278M180 397H312M180 411H288"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g className="transform-fill motion-safe:group-hover/card:animate-capability-rise motion-safe:group-focus-within/card:animate-capability-rise [--capability-delay:300ms]">
            <path
              d="M466 322H334V366H466V322Z"
              vectorEffect="non-scaling-stroke"
              className="fill-gray-200 stroke-gray-500/55"
            />
            <path
              d="M334 383H432M334 397H466M334 411H442"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g className="transform-fill motion-safe:group-hover/card:animate-capability-rise motion-safe:group-focus-within/card:animate-capability-rise [--capability-delay:450ms]">
            <path
              d="M620 322H488V366H620V322Z"
              vectorEffect="non-scaling-stroke"
              className="fill-gray-200 stroke-gray-500/55"
            />
            <path
              d="M488 383H586M488 397H620M488 411H596"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
        </g>
      </>
    ),
  },
  chart: {
    viewBox: "134 94 532 372",
    frame: "h-[99px] w-[141px] right-[45.5px] top-[14.5px]",
    drawing: (
      <>
        <g>
          <g>
            <path
              d="M652 100H148C143.582 100 140 103.582 140 108V452C140 456.418 143.582 460 148 460H652C656.418 460 660 456.418 660 452V108C660 103.582 656.418 100 652 100Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g>
            <path
              d="M200 150V400H620M194 180H200M194 220H200M194 260H200M194 300H200M194 340H200M194 380H200M250 400V406M326 400V406M402 400V406M478 400V406M554 400V406"
              strokeWidth={1.2}
              strokeLinecap="square"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g className="transform-fill origin-bottom motion-safe:group-hover/card:animate-capability-grow motion-safe:group-focus-within/card:animate-capability-grow [--capability-duration:600ms] ">
            <path
              d="M269 330H231V400H269V330Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-gray-200 stroke-gray-500/55"
            />
          </g>
          <g className="transform-fill origin-bottom motion-safe:group-hover/card:animate-capability-grow motion-safe:group-focus-within/card:animate-capability-grow [--capability-duration:600ms] [--capability-delay:80ms]">
            <path
              d="M345 300H307V400H345V300Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-gray-200 stroke-gray-500/55"
            />
          </g>
          <g className="transform-fill origin-bottom motion-safe:group-hover/card:animate-capability-grow motion-safe:group-focus-within/card:animate-capability-grow [--capability-duration:600ms] [--capability-delay:160ms]">
            <path
              d="M421 265H383V400H421V265Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-gray-200 stroke-gray-500/55"
            />
          </g>
          <g className="transform-fill origin-bottom motion-safe:group-hover/card:animate-capability-grow motion-safe:group-focus-within/card:animate-capability-grow [--capability-duration:600ms] [--capability-delay:240ms]">
            <path
              d="M497 225H459V400H497V225Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-gray-200 stroke-gray-500/55"
            />
          </g>
          <g className="transform-fill origin-bottom motion-safe:group-hover/card:animate-capability-grow motion-safe:group-focus-within/card:animate-capability-grow [--capability-duration:600ms] [--capability-delay:320ms]">
            <path d="M573 180H535V400H573V180Z" className="fill-primary" />
          </g>
          <g>
            <path
              d="M220 318C253 315 289 295 326 282C363 269 379 261 402 246C425 231 451 219 478 205C505 191 531 164 554 158C577 152 580 151 596 148"
              strokeWidth={1.2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              pathLength={1}
              className="fill-none stroke-gray-500/55 [stroke-dasharray:1_1] motion-safe:group-hover/card:animate-capability-draw motion-safe:group-focus-within/card:animate-capability-draw [--capability-duration:800ms] [--capability-delay:400ms]"
            />
          </g>
        </g>
      </>
    ),
  },
  scheduled: {
    viewBox: "181 88 452 360",
    frame: "h-[104px] w-[131px] right-[56.5px] top-[12px]",
    drawing: (
      <>
        <g>
          <g>
            <path d="M487 310H627V332H487V310Z" className="fill-card" />
            <path
              d="M487 310H627V442H459V394"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M460 332H627M459 354H627M459 376H627M459 398H627M459 420H627M483 332V442M507 332V442M531 332V442M555 332V442M579 332V442M603 332V442"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <g>
              <path
                d="M513 303V317M597 303V317"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
            </g>
            <path
              d="M567 392C569.761 392 572 389.761 572 387C572 384.239 569.761 382 567 382C564.239 382 562 384.239 562 387C562 389.761 564.239 392 567 392Z"
              className="fill-primary"
            />
          </g>
          <g>
            <path
              d="M487 244C487 283.782 471.196 321.936 443.066 350.066C414.936 378.196 376.782 394 337 394C297.218 394 259.064 378.196 230.934 350.066C202.804 321.936 187 283.782 187 244C187 204.218 202.804 166.064 230.934 137.934C259.064 109.804 297.218 94 337 94C376.782 94 414.936 109.804 443.066 137.934C471.196 166.064 487 204.218 487 244ZM478 244C478 225.484 474.353 207.149 467.267 190.042C460.181 172.935 449.795 157.391 436.702 144.298C423.609 131.205 408.065 120.819 390.958 113.733C373.851 106.647 355.516 103 337 103C318.484 103 300.149 106.647 283.042 113.733C265.935 120.819 250.391 131.205 237.298 144.298C224.205 157.391 213.819 172.935 206.733 190.042C199.647 207.149 196 225.484 196 244C196 262.516 199.647 280.851 206.733 297.958C213.819 315.065 224.205 330.609 237.298 343.702C250.391 356.795 265.935 367.181 283.042 374.267C300.149 381.353 318.484 385 337 385C355.516 385 373.851 381.353 390.958 374.267C408.065 367.181 423.609 356.795 436.702 343.702C449.795 330.609 460.181 315.065 467.267 297.958C474.353 280.851 478 262.516 478 244Z"
              className="fill-card"
            />
            <path
              d="M337 394C419.843 394 487 326.843 487 244C487 161.157 419.843 94 337 94C254.157 94 187 161.157 187 244C187 326.843 254.157 394 337 394Z"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <g>
              <path
                d="M337 112V101M351.53 105.76L351.95 101.78M365.9 108.04L366.73 104.12M379.95 111.8L381.19 108M393.54 117L395.16 113.36M403 129.68L408.5 120.16M418.7 131.55L421.05 128.31M430.01 140.71L432.69 137.73M440.29 150.99L443.27 148.31M449.45 162.3L452.69 159.95M451.32 178L460.84 172.5M464 187.46L467.64 185.84M469.2 201.05L473 199.81M472.96 215.1L476.88 214.27M475.24 229.47L479.22 229.05"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
              <path
                d="M469 244H480M475.24 258.53L479.22 258.95M472.96 272.9L476.88 273.73M469.2 286.95L473 288.19M464 300.54L467.64 302.16M451.32 310L460.84 315.5M449.45 325.7L452.69 328.05M440.29 337.01L443.27 339.69M430.01 347.29L432.69 350.27M418.7 356.45L421.05 359.69M403 358.32L408.5 367.84M393.54 371L395.16 374.64M379.95 376.2L381.19 380M365.9 379.96L366.73 383.88M351.53 382.24L351.95 386.22"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
              <path
                d="M337 376V387M322.47 382.24L322.05 386.22M308.1 379.96L307.27 383.88M294.05 376.2L292.81 380M280.46 371L278.84 374.64M271 358.32L265.5 367.84M255.3 356.45L252.95 359.69M243.99 347.29L241.31 350.27M233.71 337.01L230.73 339.69M224.55 325.7L221.31 328.05M222.68 310L213.16 315.5M210 300.54L206.36 302.16M204.8 286.95L201 288.19M201.04 272.9L197.12 273.73M198.76 258.53L194.78 258.95"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
              <path
                d="M205 244H194M198.76 229.47L194.78 229.05M201.04 215.1L197.12 214.27M204.8 201.05L201 199.81M210 187.46L206.36 185.84M222.68 178L213.16 172.5M224.55 162.3L221.31 159.95M233.71 150.99L230.73 148.31M243.99 140.71L241.31 137.73M255.3 131.55L252.95 128.31M271 129.68L265.5 120.16M280.46 117L278.84 113.36M294.05 111.8L292.81 108M308.1 108.04L307.27 104.12M322.47 105.76L322.05 101.78"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
            </g>
            <g>
              <path
                d="M333 245L272 198L337 239L333 245Z"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className="fill-card stroke-gray-500/55"
              />
              <path
                d="M336 240L424 166L340 246L336 240Z"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className="fill-card stroke-gray-500/55 transform-view origin-[337px_244px] motion-safe:group-hover/card:animate-capability-spin motion-safe:group-focus-within/card:animate-capability-spin"
              />
              <path
                d="M337 248C339.209 248 341 246.209 341 244C341 241.791 339.209 240 337 240C334.791 240 333 241.791 333 244C333 246.209 334.791 248 337 248Z"
                vectorEffect="non-scaling-stroke"
                className="fill-card stroke-gray-500/55"
              />
            </g>
          </g>
        </g>
        <circle
          cx="567"
          cy="387"
          r="16"
          strokeWidth={4}
          className="fill-none stroke-primary opacity-0 transform-fill origin-center motion-safe:group-hover/card:animate-capability-ring motion-safe:group-focus-within/card:animate-capability-ring [--capability-delay:600ms]"
        />
      </>
    ),
  },
  triggers: {
    viewBox: "146 186 524 188",
    frame: "h-[70px] w-[196px] right-[24px] top-[29px]",
    drawing: (
      <>
        <g>
          <g>
            <path
              d="M264 208H184C166.327 208 152 222.327 152 240V320C152 337.673 166.327 352 184 352H264C281.673 352 296 337.673 296 320V240C296 222.327 281.673 208 264 208Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <path
              d="M231 244L203 284H222L215 316L246 272H227L231 244Z"
              strokeWidth={1.2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-gray-200 stroke-gray-500/55"
            />
          </g>
          <g>
            <path
              d="M296 280H452M444 285L452 280L444 275"
              strokeWidth={1.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M376 284C378.209 284 380 282.209 380 280C380 277.791 378.209 276 376 276C373.791 276 372 277.791 372 280C372 282.209 373.791 284 376 284Z"
              className="fill-primary transform-fill motion-safe:group-hover/card:animate-capability-travel motion-safe:group-focus-within/card:animate-capability-travel"
            />
          </g>
          <g className="transform-fill origin-center motion-safe:group-hover/card:animate-capability-receive motion-safe:group-focus-within/card:animate-capability-receive">
            <path
              d="M640 192H480C466.745 192 456 202.745 456 216V344C456 357.255 466.745 368 480 368H640C653.255 368 664 357.255 664 344V216C664 202.745 653.255 192 640 192Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <g>
              <path
                d="M591 255H529C526.239 255 524 257.239 524 260V300C524 302.761 526.239 305 529 305H591C593.761 305 596 302.761 596 300V260C596 257.239 593.761 255 591 255Z"
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
                className="fill-gray-200 stroke-gray-500/55"
              />
              <path
                d="M526 258L556 281C558.667 283 561.333 283 564 281L594 258M526 302L548 278M594 302L572 278"
                strokeWidth={1.2}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className="fill-none stroke-gray-500/55"
              />
            </g>
          </g>
        </g>
        <circle
          cx="224"
          cy="280"
          r="72"
          strokeWidth={4}
          className="fill-none stroke-primary opacity-0 transform-fill origin-center motion-safe:group-hover/card:animate-capability-ring motion-safe:group-focus-within/card:animate-capability-ring"
        />
      </>
    ),
  },
  advanced: {
    viewBox: "118 143 576 239",
    frame: "h-[76px] w-[184px] right-[30px] top-[26px]",
    drawing: (
      <>
        <g>
          <g>
            <path
              d="M236 338C286 338 294 308 344 308M456 308C510 308 526 338 576 338"
              strokeWidth={1.2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M180 235V300"
              strokeWidth={1.2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M180 273C181.657 273 183 271.657 183 270C183 268.343 181.657 267 180 267C178.343 267 177 268.343 177 270C177 271.657 178.343 273 180 273Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g>
            <path
              d="M632 300V272C632 224 591 196 539 196C485 196 438 220 428 259"
              strokeWidth={1.2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M423 249L428 259L438 254"
              strokeWidth={1.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g>
            <path
              d="M223 300H137C129.82 300 124 305.82 124 313V363C124 370.18 129.82 376 137 376H223C230.18 376 236 370.18 236 363V313C236 305.82 230.18 300 223 300Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-gray-200 stroke-gray-500/55 motion-safe:group-hover/card:animate-capability-lit motion-safe:group-focus-within/card:animate-capability-lit"
            />
            <path
              d="M162 319H144V337"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M180 347C184.971 347 189 342.971 189 338C189 333.029 184.971 329 180 329C175.029 329 171 333.029 171 338C171 342.971 175.029 347 180 347Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M198 357H216V339"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g>
            <path
              d="M443 270H357C349.82 270 344 275.82 344 283V333C344 340.18 349.82 346 357 346H443C450.18 346 456 340.18 456 333V283C456 275.82 450.18 270 443 270Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-gray-200 stroke-gray-500/55 motion-safe:group-hover/card:animate-capability-lit motion-safe:group-focus-within/card:animate-capability-lit [--capability-delay:300ms]"
            />
            <path
              d="M382 289H364V307"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M400 297L411 308L400 319L389 308L400 297Z"
              strokeWidth={1.2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M418 327H436V309"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g>
            <path
              d="M675 300H589C581.82 300 576 305.82 576 313V363C576 370.18 581.82 376 589 376H675C682.18 376 688 370.18 688 363V313C688 305.82 682.18 300 675 300Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-gray-200 stroke-gray-500/55 motion-safe:group-hover/card:animate-capability-lit motion-safe:group-focus-within/card:animate-capability-lit [--capability-delay:600ms]"
            />
            <path
              d="M614 319H596V337"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M632 348C637.523 348 642 343.523 642 338C642 332.477 637.523 328 632 328C626.477 328 622 332.477 622 338C622 343.523 626.477 348 632 348Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M627 338L631 342L637 334"
              strokeWidth={1.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M650 357H668V339"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
          </g>
          <g>
            <path
              d="M180 235C203.748 235 223 215.748 223 192C223 168.252 203.748 149 180 149C156.252 149 137 168.252 137 192C137 215.748 156.252 235 180 235Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
            <path
              d="M180 155V161M198.5 159.96L196.5 163.43M212.04 173.5L208.57 175.5M217 192H211M212.04 210.5L208.57 208.5M198.5 224.04L196.5 220.57M180 229V223M161.5 224.04L163.5 220.57M147.96 210.5L151.43 208.5M143 192H149M147.96 173.5L151.43 175.5M161.5 159.96L163.5 163.43"
              strokeWidth={1.2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M180 169V192L195 201"
              strokeWidth={1.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="fill-none stroke-gray-500/55"
            />
            <path
              d="M180 194.5C181.381 194.5 182.5 193.381 182.5 192C182.5 190.619 181.381 189.5 180 189.5C178.619 189.5 177.5 190.619 177.5 192C177.5 193.381 178.619 194.5 180 194.5Z"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              className="fill-card stroke-gray-500/55"
            />
          </g>
          <g>
            <path
              d="M290 327.5C292.761 327.5 295 325.261 295 322.5C295 319.739 292.761 317.5 290 317.5C287.239 317.5 285 319.739 285 322.5C285 325.261 287.239 327.5 290 327.5Z"
              className="fill-primary"
            />
          </g>
        </g>
        <path
          d="M236 338C286 338 294 308 344 308"
          pathLength={1}
          strokeWidth={6}
          strokeLinecap="round"
          className="fill-none stroke-primary opacity-0 [stroke-dasharray:0.22_1.5] [stroke-dashoffset:0.22] motion-safe:group-hover/card:animate-capability-run motion-safe:group-focus-within/card:animate-capability-run [--capability-duration:600ms] [--capability-delay:150ms]"
        />
        <path
          d="M456 308C510 308 526 338 576 338"
          pathLength={1}
          strokeWidth={6}
          strokeLinecap="round"
          className="fill-none stroke-primary opacity-0 [stroke-dasharray:0.22_1.5] [stroke-dashoffset:0.22] motion-safe:group-hover/card:animate-capability-run motion-safe:group-focus-within/card:animate-capability-run [--capability-duration:600ms] [--capability-delay:600ms]"
        />
      </>
    ),
  },
} as const satisfies Record<
  CapabilityArt,
  {
    readonly viewBox: string;
    readonly frame: string;
    readonly drawing: ReactNode;
  }
>;

export function CapabilityIllustration({
  art,
  className,
  thumb = false,
}: {
  readonly art: CapabilityArt;
  readonly className?: string;
  /** A small static copy for the capability row, outside any card. */
  readonly thumb?: boolean;
}) {
  const { viewBox, frame, drawing } = ARTS[art];
  return (
    <svg
      aria-hidden
      viewBox={viewBox}
      fill="none"
      className={cn(
        thumb
          ? "h-10 w-13 shrink-0"
          : cn("pointer-events-none absolute z-[1] overflow-visible", frame),
        className,
      )}
    >
      {drawing}
    </svg>
  );
}
