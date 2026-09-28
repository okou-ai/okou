import { createImageGenerateCommand } from "../shared/image-generate";

export const imageCommand = createImageGenerateCommand({
  name: "image",
  generationType: "image",
  usageCommand: "okou generate image",
  examples: `  Compile styled prompt: okou generate image --style image-style:notion-illustration --prompt "A product manager mapping a launch plan" --compile
  Generate compiled:     okou generate image --compiled-prompt "A Notion-style brush-pen illustration..."
  Generate raw:          okou generate image --raw-prompt "A watercolor fox"
  Pipe compile prompt:   cat prompt.txt | okou generate image --style image-style:notion-illustration --compile
  Size and quality:      okou generate image --compiled-prompt "A poster" --size 1024x1536 --quality high
  Image-to-image:        okou generate image --compiled-prompt "Turn this mockup into a polished product shot" --image-url https://example.com/mockup.png
  List providers:        okou generate image
  Use a connector:       okou generate image --provider replicate`,
});
